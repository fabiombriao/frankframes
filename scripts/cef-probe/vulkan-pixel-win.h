// FrankFrames — proprietário. Ver LICENSE na raiz.
#include <windows.h>

#define VK_USE_PLATFORM_WIN32_KHR
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>

#include <array>
#include <cstring>
#include <stdexcept>
#include <string>

#include "render-graph-win.h"

extern "C" {
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/error.h>
#include <libavutil/hwcontext_vulkan.h>
}

#define VK_FUNCTIONS(X) \
  X(vkGetPhysicalDeviceProperties2) X(vkGetPhysicalDeviceImageFormatProperties2) \
  X(vkGetPhysicalDeviceMemoryProperties) X(vkGetPhysicalDeviceFormatProperties) X(vkGetDeviceQueue) X(vkGetDeviceProcAddr) X(vkDeviceWaitIdle) \
  X(vkCreateImage) X(vkDestroyImage) X(vkGetImageMemoryRequirements) X(vkBindImageMemory) \
  X(vkCreateBuffer) X(vkDestroyBuffer) X(vkGetBufferMemoryRequirements) X(vkBindBufferMemory) \
  X(vkAllocateMemory) X(vkFreeMemory) X(vkMapMemory) X(vkUnmapMemory) \
  X(vkCreateCommandPool) X(vkDestroyCommandPool) X(vkAllocateCommandBuffers) \
  X(vkResetCommandBuffer) X(vkBeginCommandBuffer) X(vkEndCommandBuffer) X(vkCmdPipelineBarrier) \
  X(vkCmdCopyImageToBuffer) X(vkCmdCopyImage) X(vkCmdBlitImage) \
  X(vkCreateFence) X(vkDestroyFence) X(vkResetFences) X(vkWaitForFences) X(vkQueueSubmit)

class VulkanPixelProbe {
 public:
  struct Markers {
    std::array<uint8_t, 4> seek;
    std::array<uint8_t, 4> alpha;
  };

  ~VulkanPixelProbe() {
    if (device_) {
      vkDeviceWaitIdle(device_);
      render_.reset();
      av_frame_free(&input_);
      av_frame_free(&output_);
      avfilter_graph_free(&graph_);
      av_buffer_unref(&frames_);
      if (pixel_) vkUnmapMemory(device_, pixel_memory_);
      vkDestroyBuffer(device_, buffer_, nullptr);
      vkFreeMemory(device_, pixel_memory_, nullptr);
      vkDestroyImage(device_, image_, nullptr);
      vkFreeMemory(device_, image_memory_, nullptr);
      vkDestroyCommandPool(device_, pool_, nullptr);
      vkDestroyFence(device_, fence_, nullptr);
    }
    av_buffer_unref(&av_device_);
    if (loader_) FreeLibrary(loader_);
  }

  void SetRenderPlan(ff::RenderPlan plan) {
    render_ = std::make_unique<ff::RenderGraph>(std::move(plan));
  }

  void Import(HANDLE handle, const LUID& adapter, uint32_t width, uint32_t shared_height,
              uint32_t content_height, AVRational time_base) {
    loader_ = LoadLibraryExW(L"vulkan-1.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!loader_) throw std::runtime_error("vulkan-1.dll");
#define LOAD(name) name = Load<PFN_##name>(#name);
    VK_FUNCTIONS(LOAD)
#undef LOAD
    InitDevice(adapter);
    vkGetPhysicalDeviceMemoryProperties(physical_, &memory_);
    vkGetDeviceQueue(device_, family_, 0, &queue_);
    CreateImage(handle, width, shared_height);
    CreateReadback();
    InitCommands();
    InitFilter(width, content_height, time_base);
  }

  Markers CopyFrame() {
    av_frame_unref(input_);
    CheckAv(av_hwframe_get_buffer(frames_, input_, 0), "av_hwframe_get_buffer");
    auto* frame = reinterpret_cast<AVVkFrame*>(input_->data[0]);
    Record(*frame);
    const uint64_t signaled = frame->sem_value[0] + 1;
    const VkTimelineSemaphoreSubmitInfo timeline = {
      VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO, nullptr, 1, &frame->sem_value[0], 1, &signaled
    };
    constexpr uint64_t read = 1;
    constexpr uint64_t write = 0;
    constexpr uint32_t timeout_ms = 1000;
    const VkWin32KeyedMutexAcquireReleaseInfoKHR mutex = {
      VK_STRUCTURE_TYPE_WIN32_KEYED_MUTEX_ACQUIRE_RELEASE_INFO_KHR, &timeline,
      1, &image_memory_, &read, &timeout_ms, 1, &image_memory_, &write
    };
    constexpr VkPipelineStageFlags wait_stage = VK_PIPELINE_STAGE_TRANSFER_BIT;
    const VkSubmitInfo submit = {
      VK_STRUCTURE_TYPE_SUBMIT_INFO, &mutex, 1, frame->sem, &wait_stage, 1, &command_, 1, frame->sem
    };
    Check(vkResetFences(device_, 1, &fence_), "vkResetFences");
    Check(vkQueueSubmit(queue_, 1, &submit, fence_), "vkQueueSubmit");
    Check(vkWaitForFences(device_, 1, &fence_, VK_TRUE, 2'000'000'000), "vkWaitForFences");
    frame->layout[0] = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
    frame->access[0] = VK_ACCESS_2_TRANSFER_WRITE_BIT;
    frame->sem_value[0] = signaled;
    Markers markers{};
    std::memcpy(&markers, pixel_, sizeof(markers));
    return markers;
  }

  void FilterFrame(int64_t pts) {
    input_->pts = pts;
    input_->color_range = AVCOL_RANGE_JPEG;
    input_->color_trc = AVCOL_TRC_IEC61966_2_1;
    input_->alpha_mode = AVALPHA_MODE_PREMULTIPLIED;
    if (render_) {
      input_->colorspace = AVCOL_SPC_RGB;
      input_->color_primaries = AVCOL_PRI_BT709;
      render_->Submit(input_);
      return;
    }
    CheckAv(av_buffersrc_write_frame(source_, input_), "av_buffersrc_write_frame");
    Drain(false);
  }

  void Finish(int64_t count) {
    if (render_) {
      render_->Finish(count);
      return;
    }
    CheckAv(av_buffersrc_close(source_, count, 0), "av_buffersrc_close");
    Drain(true);
    if (filtered_ != count) {
      throw std::runtime_error("contagem de AVFrames Vulkan diferente da captura");
    }
  }

  void BackgroundFrame() {
    if (!render_) throw std::runtime_error("fundo sem plano CEF");
    input_->colorspace = AVCOL_SPC_RGB;
    input_->color_range = AVCOL_RANGE_JPEG;
    input_->color_trc = AVCOL_TRC_IEC61966_2_1;
    input_->color_primaries = AVCOL_PRI_BT709;
    input_->alpha_mode = AVALPHA_MODE_PREMULTIPLIED;
    render_->SubmitBackground(input_);
  }

 private:
  void Drain(bool closed) {
    while (true) {
      const int result = av_buffersink_get_frame(sink_, output_);
      if (result == AVERROR_EOF || (!closed && result == AVERROR(EAGAIN))) return;
      CheckAv(result, "av_buffersink_get_frame");
      if (output_->format != AV_PIX_FMT_VULKAN || output_->pts != filtered_ || !output_->hw_frames_ctx) {
        throw std::runtime_error("libplacebo não devolveu o AVFrame Vulkan esperado no PTS " +
          std::to_string(filtered_) + ": formato " + std::to_string(output_->format) +
          ", PTS " + std::to_string(output_->pts));
      }
      ++filtered_;
      av_frame_unref(output_);
    }
  }

  static constexpr VkFormat kFormat = VK_FORMAT_B8G8R8A8_UNORM;
  static constexpr VkExternalMemoryHandleTypeFlagBits kHandle = VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT;
  static constexpr VkImageUsageFlags kUsage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;

  template <typename Function>
  Function Load(const char* symbol) {
    const auto addr = GetProcAddress(loader_, symbol);
    if (!addr) throw std::runtime_error(symbol);
    return reinterpret_cast<Function>(addr);
  }

  static void Check(VkResult result, const char* operation) {
    if (result != VK_SUCCESS) throw std::runtime_error(std::string(operation) + ": " + std::to_string(result));
  }

  static void CheckAv(int result, const char* operation) {
    if (result >= 0) return;
    char message[AV_ERROR_MAX_STRING_SIZE]{};
    av_strerror(result, message, sizeof(message));
    throw std::runtime_error(std::string(operation) + ": " + message);
  }

  void InitDevice(const LUID& adapter) {
    static_assert(sizeof(adapter) == VK_LUID_SIZE);
    constexpr const char* extensions = VK_KHR_EXTERNAL_MEMORY_WIN32_EXTENSION_NAME "+" VK_KHR_WIN32_KEYED_MUTEX_EXTENSION_NAME;
    AVDictionary* opts = nullptr;
    CheckAv(av_dict_set(&opts, "device_extensions", extensions, 0), "av_dict_set");
    const int result = av_hwdevice_ctx_create(&av_device_, AV_HWDEVICE_TYPE_VULKAN, "NVIDIA", opts, 0);
    av_dict_free(&opts);
    CheckAv(result, "av_hwdevice_ctx_create");
    const auto* context = reinterpret_cast<const AVHWDeviceContext*>(av_device_->data);
    const auto* vulkan = reinterpret_cast<const AVVulkanDeviceContext*>(context->hwctx);
    physical_ = vulkan->phys_dev;
    device_ = vulkan->act_dev;
    VkPhysicalDeviceIDProperties id = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES};
    VkPhysicalDeviceProperties2 props = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, &id};
    vkGetPhysicalDeviceProperties2(physical_, &props);
    if (!id.deviceLUIDValid || std::memcmp(id.deviceLUID, &adapter, VK_LUID_SIZE) != 0) {
      throw std::runtime_error("FFmpeg Vulkan e D3D11 selecionaram adaptadores diferentes");
    }
    for (int i = 0; i < vulkan->nb_qf; ++i) {
      if (vulkan->qf[i].flags & (VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT)) {
        family_ = static_cast<uint32_t>(vulkan->qf[i].idx);
        return;
      }
    }
    throw std::runtime_error("fila Vulkan graphics/compute ausente");
  }

  void InitFilter(uint32_t width, uint32_t height, AVRational time_base) {
    frames_ = av_hwframe_ctx_alloc(av_device_);
    input_ = av_frame_alloc();
    if (!frames_ || !input_) throw std::runtime_error("alocação de superfície FFmpeg");
    auto* frames = reinterpret_cast<AVHWFramesContext*>(frames_->data);
    frames->format = AV_PIX_FMT_VULKAN;
    frames->sw_format = render_ ? AV_PIX_FMT_RGBA : AV_PIX_FMT_BGRA;
    frames->width = static_cast<int>(width);
    frames->height = static_cast<int>(height);
    CheckAv(av_hwframe_ctx_init(frames_), "av_hwframe_ctx_init");
    if (render_) {
      VkFormatProperties source{}, destination{};
      vkGetPhysicalDeviceFormatProperties(physical_, VK_FORMAT_B8G8R8A8_UNORM, &source);
      vkGetPhysicalDeviceFormatProperties(physical_, VK_FORMAT_R8G8B8A8_UNORM, &destination);
      if (!(source.optimalTilingFeatures & VK_FORMAT_FEATURE_BLIT_SRC_BIT) ||
          !(destination.optimalTilingFeatures & VK_FORMAT_FEATURE_BLIT_DST_BIT)) {
        throw std::runtime_error("Vulkan não converte BGRA → RGBA na GPU");
      }
      render_->Init(av_device_, frames_, time_base);
      return;
    }
    output_ = av_frame_alloc();
    graph_ = avfilter_graph_alloc();
    if (!output_ || !graph_) throw std::runtime_error("alocação do filtro FFmpeg");
    auto* source = avfilter_graph_alloc_filter(graph_, avfilter_get_by_name("buffer"), "cef");
    auto* compositor = avfilter_graph_alloc_filter(graph_, avfilter_get_by_name("libplacebo"), "gpu");
    if (!source || !compositor) throw std::runtime_error("filtros buffer/libplacebo indisponíveis");
    compositor->hw_device_ctx = av_buffer_ref(av_device_);
    AVBufferSrcParameters* params = av_buffersrc_parameters_alloc();
    if (!params || !compositor->hw_device_ctx) {
      av_free(params);
      throw std::runtime_error("alocação dos parâmetros de entrada");
    }
    params->format = AV_PIX_FMT_VULKAN;
    params->width = frames->width;
    params->height = frames->height;
    params->sample_aspect_ratio = {1, 1};
    params->time_base = time_base;
    params->frame_rate = av_inv_q(time_base);
    params->color_range = AVCOL_RANGE_JPEG;
    params->alpha_mode = AVALPHA_MODE_PREMULTIPLIED;
    params->hw_frames_ctx = frames_;
    const int applied = av_buffersrc_parameters_set(source, params);
    av_free(params);
    CheckAv(applied, "av_buffersrc_parameters_set");
    CheckAv(avfilter_init_str(source, nullptr), "init buffer");
    CheckAv(avfilter_init_str(compositor, "format=bgra:disable_linear=1:dithering=none"), "init libplacebo");
    AVFilterContext* pin = nullptr;
    CheckAv(avfilter_graph_create_filter(&pin, avfilter_get_by_name("format"), "vulkan", "pix_fmts=vulkan",
                                         nullptr, graph_), "init format=vulkan");
    CheckAv(avfilter_graph_create_filter(&sink_, avfilter_get_by_name("buffersink"), "saida", nullptr, nullptr, graph_),
            "init buffersink");
    CheckAv(avfilter_link(source, 0, compositor, 0), "buffer → libplacebo");
    CheckAv(avfilter_link(compositor, 0, pin, 0), "libplacebo → format");
    CheckAv(avfilter_link(pin, 0, sink_, 0), "format → buffersink");
    CheckAv(avfilter_graph_config(graph_, nullptr), "avfilter_graph_config");
    source_ = source;
  }

  uint32_t MemoryType(uint32_t bits, VkMemoryPropertyFlags flags) const {
    for (uint32_t i = 0; i < memory_.memoryTypeCount; ++i) {
      if ((bits & (1u << i)) && (memory_.memoryTypes[i].propertyFlags & flags) == flags) return i;
    }
    throw std::runtime_error("tipo de memória Vulkan incompatível");
  }

  void CreateImage(HANDLE handle, uint32_t width, uint32_t height) {
    const VkPhysicalDeviceExternalImageFormatInfo external = {
      VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO, nullptr, kHandle
    };
    const VkPhysicalDeviceImageFormatInfo2 query = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_FORMAT_INFO_2,
      &external, kFormat, VK_IMAGE_TYPE_2D, VK_IMAGE_TILING_OPTIMAL, kUsage};
    VkExternalImageFormatProperties shared = {VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES};
    VkImageFormatProperties2 props = {VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2, &shared};
    Check(vkGetPhysicalDeviceImageFormatProperties2(physical_, &query, &props), "consulta imagem externa");
    if (!(shared.externalMemoryProperties.externalMemoryFeatures & VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT)) {
      throw std::runtime_error("textura D3D11 não importável pelo Vulkan");
    }
    const VkExternalMemoryImageCreateInfo external_image = {VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO,
                                                           nullptr, kHandle};
    const VkImageCreateInfo image_info = {
      VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, &external_image, 0, VK_IMAGE_TYPE_2D, kFormat,
      {width, height, 1}, 1, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_TILING_OPTIMAL, kUsage, VK_SHARING_MODE_EXCLUSIVE
    };
    Check(vkCreateImage(device_, &image_info, nullptr, &image_), "vkCreateImage");
    const auto get_win32_props = reinterpret_cast<PFN_vkGetMemoryWin32HandlePropertiesKHR>(
        vkGetDeviceProcAddr(device_, "vkGetMemoryWin32HandlePropertiesKHR"));
    if (!get_win32_props) throw std::runtime_error("vkGetMemoryWin32HandlePropertiesKHR");
    VkMemoryWin32HandlePropertiesKHR win32_props = {VK_STRUCTURE_TYPE_MEMORY_WIN32_HANDLE_PROPERTIES_KHR};
    Check(get_win32_props(device_, kHandle, handle, &win32_props), "vkGetMemoryWin32HandlePropertiesKHR");
    VkMemoryRequirements req{};
    vkGetImageMemoryRequirements(device_, image_, &req);
    const VkImportMemoryWin32HandleInfoKHR import = {VK_STRUCTURE_TYPE_IMPORT_MEMORY_WIN32_HANDLE_INFO_KHR,
                                                   nullptr, kHandle, handle};
    const VkMemoryDedicatedAllocateInfo dedicated = {VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO, &import, image_};
    const VkMemoryAllocateInfo alloc = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, &dedicated, req.size,
      MemoryType(req.memoryTypeBits & win32_props.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)};
    Check(vkAllocateMemory(device_, &alloc, nullptr, &image_memory_), "importação VkDeviceMemory");
    Check(vkBindImageMemory(device_, image_, image_memory_, 0), "vkBindImageMemory");
  }

  void CreateReadback() {
    const VkBufferCreateInfo buffer = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, nullptr, 0, sizeof(Markers),
                                       VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_SHARING_MODE_EXCLUSIVE};
    Check(vkCreateBuffer(device_, &buffer, nullptr, &buffer_), "vkCreateBuffer");
    VkMemoryRequirements req{};
    vkGetBufferMemoryRequirements(device_, buffer_, &req);
    const VkMemoryAllocateInfo alloc = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, nullptr, req.size,
      MemoryType(req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)};
    Check(vkAllocateMemory(device_, &alloc, nullptr, &pixel_memory_), "alocação pixel de diagnóstico");
    Check(vkBindBufferMemory(device_, buffer_, pixel_memory_, 0), "vkBindBufferMemory");
    Check(vkMapMemory(device_, pixel_memory_, 0, sizeof(Markers), 0, &pixel_), "vkMapMemory");
  }

  void InitCommands() {
    const VkCommandPoolCreateInfo pool = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, nullptr,
                                          VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, family_};
    Check(vkCreateCommandPool(device_, &pool, nullptr, &pool_), "vkCreateCommandPool");
    const VkCommandBufferAllocateInfo alloc = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, nullptr, pool_,
                                              VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1};
    Check(vkAllocateCommandBuffers(device_, &alloc, &command_), "vkAllocateCommandBuffers");
    const VkFenceCreateInfo fence = {VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    Check(vkCreateFence(device_, &fence, nullptr, &fence_), "vkCreateFence");
  }

  void Record(const AVVkFrame& output) {
    if (output.queue_family[0] != family_ && output.queue_family[0] != VK_QUEUE_FAMILY_IGNORED) {
      throw std::runtime_error("família de filas do AVFrame incompatível");
    }
    Check(vkResetCommandBuffer(command_, 0), "vkResetCommandBuffer");
    const VkCommandBufferBeginInfo begin = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    Check(vkBeginCommandBuffer(command_, &begin), "vkBeginCommandBuffer");
    const VkImageMemoryBarrier acquire = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, nullptr,
      0, VK_ACCESS_TRANSFER_READ_BIT, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
      VK_QUEUE_FAMILY_EXTERNAL, family_, image_, {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
    vkCmdPipelineBarrier(command_, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         0, 0, nullptr, 0, nullptr, 1, &acquire);
    const VkBufferImageCopy sample = {0, 0, 0, {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1},
                                      {1, input_->height + 1, 0}, {2, 1, 1}};
    vkCmdCopyImageToBuffer(command_, image_, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buffer_, 1, &sample);
    const VkImageMemoryBarrier dest = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, nullptr,
      0, VK_ACCESS_TRANSFER_WRITE_BIT, output.layout[0], VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
      VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, output.img[0], {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
    vkCmdPipelineBarrier(command_, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         0, 0, nullptr, 0, nullptr, 1, &dest);
    const VkImageSubresourceLayers layer = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    if (render_) {
      const VkOffset3D corner{input_->width, input_->height, 1};
      const VkImageBlit blit{layer, {{0, 0, 0}, corner}, layer, {{0, 0, 0}, corner}};
      vkCmdBlitImage(command_, image_, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, output.img[0],
                     VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &blit, VK_FILTER_NEAREST);
    } else {
      const VkImageCopy copy = {layer, {0, 0, 0}, layer, {0, 0, 0},
        {static_cast<uint32_t>(input_->width), static_cast<uint32_t>(input_->height), 1}};
      vkCmdCopyImage(command_, image_, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, output.img[0],
                     VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &copy);
    }
    const VkImageMemoryBarrier release = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, nullptr,
      VK_ACCESS_TRANSFER_READ_BIT, 0, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_IMAGE_LAYOUT_GENERAL,
      family_, VK_QUEUE_FAMILY_EXTERNAL, image_, {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
    const VkBufferMemoryBarrier readback = {VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER, nullptr,
      VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_HOST_READ_BIT, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED,
      buffer_, 0, sizeof(Markers)};
    vkCmdPipelineBarrier(command_, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT | VK_PIPELINE_STAGE_HOST_BIT,
                         0, 0, nullptr, 1, &readback, 1, &release);
    Check(vkEndCommandBuffer(command_), "vkEndCommandBuffer");
  }

  HMODULE loader_ = nullptr;
  AVBufferRef* av_device_ = nullptr;
  std::unique_ptr<ff::RenderGraph> render_;
  AVBufferRef* frames_ = nullptr;
  AVFrame* input_ = nullptr;
  AVFrame* output_ = nullptr;
  AVFilterGraph* graph_ = nullptr;
  AVFilterContext* source_ = nullptr;
  AVFilterContext* sink_ = nullptr;
  int64_t filtered_ = 0;
  VkPhysicalDevice physical_ = VK_NULL_HANDLE;
  VkPhysicalDeviceMemoryProperties memory_{};
  VkDevice device_ = VK_NULL_HANDLE;
  VkQueue queue_ = VK_NULL_HANDLE;
  uint32_t family_ = 0;
  VkImage image_ = VK_NULL_HANDLE;
  VkDeviceMemory image_memory_ = VK_NULL_HANDLE;
  VkBuffer buffer_ = VK_NULL_HANDLE;
  VkDeviceMemory pixel_memory_ = VK_NULL_HANDLE;
  void* pixel_ = nullptr;
  VkCommandPool pool_ = VK_NULL_HANDLE;
  VkCommandBuffer command_ = VK_NULL_HANDLE;
  VkFence fence_ = VK_NULL_HANDLE;

#define DECLARE(name) PFN_##name name = nullptr;
  VK_FUNCTIONS(DECLARE)
#undef DECLARE
};
#undef VK_FUNCTIONS

// FrankFrames — proprietário. Ver LICENSE na raiz.
#include <windows.h>
#include <d3d11_1.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

#include "include/cef_app.h"
#include "include/cef_client.h"
#include "vulkan-pixel-win.h"

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
constexpr int kMarkerRows = 4;

class GpuApp : public CefApp {
 public:
  void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> command) override {
    command->AppendSwitchWithValue("use-angle", "d3d11");
    command->AppendSwitchWithValue("force-device-scale-factor", "1");
    command->AppendSwitchWithValue("force-color-profile", "srgb");
    command->AppendSwitch("disable-background-timer-throttling");
    command->AppendSwitch("disable-renderer-backgrounding");
    command->AppendSwitch("disable-extensions");
    command->AppendSwitch("disable-component-extensions-with-background-pages");
    command->AppendSwitch("disable-component-update");
  }
 private:
  IMPLEMENT_REFCOUNTING(GpuApp);
};

class Probe : public CefClient, public CefRenderHandler, public CefLifeSpanHandler,
              public CefLoadHandler, public CefDisplayHandler {
 public:
  Probe(int width, int height, int total, AVRational time_base)
      : width_(width), height_(height), total_(total), time_base_(time_base),
        step_ms_(1000.0 * av_q2d(time_base)) {}

  void SetRenderPlan(ff::RenderPlan plan) {
    background_pending_ = plan.background;
    native_render_ = true;
    vulkan_.SetRenderPlan(std::move(plan));
  }

  void SetScan() { scan_ = true; }

  bool InitGpu() {
    ComPtr<ID3D11Device> device;
    const HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        device.GetAddressOf(), nullptr, context_.GetAddressOf());
    if (FAILED(hr)) return Error("D3D11CreateDevice", hr);
    const HRESULT query = device.As(&device_);
    return SUCCEEDED(query) || Error("ID3D11Device1", query);
  }

  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }

  void GetViewRect(CefRefPtr<CefBrowser>, CefRect& bounds) override {
    bounds = CefRect(0, 0, width_, height_ + kMarkerRows);
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override { browser_ = browser; }
  void OnBeforeClose(CefRefPtr<CefBrowser>) override { browser_ = nullptr; }

  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int status) override {
    if (!frame->IsMain()) return;
    if (trace_) std::fprintf(stderr, "CEF carregou HTTP %d, fundo=%d scan=%d\n", status, background_pending_, scan_);
    if (status >= 400) {
      Error("HTTP", status);
      return;
    }
    const std::string wait = background_pending_ ? "" : "await window.__ffProbeComposition.__ff.ready;";
    frame->ExecuteJavaScript(
        "(async()=>{try{window.__ffProbeComposition=document.getElementById('composition').contentWindow;" + wait +
        "const mark=document.createElement('div');mark.id='ff-cef-probe-mark';"
        "mark.style='position:fixed;bottom:0;left:1px;width:1px;height:4px;pointer-events:none';"
        "document.documentElement.appendChild(mark);"
        "const alpha=mark.cloneNode();alpha.removeAttribute('id');alpha.style.left='2px';"
        "alpha.style.background='rgb(192 96 48 / 0.5)';document.documentElement.appendChild(alpha);"
        "document.title='ff:ready';}catch(e){document.title='ff:error:'+e.message;}})()",
        frame->GetURL(), 0);
  }

  void OnTitleChange(CefRefPtr<CefBrowser>, const CefString& title) override {
    const std::string value = title.ToString();
    if (trace_ && !scan_ && captured_ < 12) std::fprintf(stderr, "CEF title %s\n", value.c_str());
    const std::string metadata = "ff:meta:" + std::to_string(captured_) + ":";
    if (value == "ff:ready") {
      if (background_pending_) RequestPaint();
      else Seek();
    } else if (!background_pending_ && value == "ff:reuse:" + std::to_string(captured_)) {
      Filter(false);
    } else if (!background_pending_ && value == "ff:seek:" + std::to_string(captured_)) {
      RequestPaint();
    } else if (scan_ && value.rfind(metadata, 0) == 0) {
      std::printf("meta %d %s\n", captured_, value.c_str() + metadata.size());
      std::fflush(stdout);
      ++captured_;
      last_capture_ = Clock::now();
      if (!Done()) Seek();
    } else if (value.rfind("ff:error:", 0) == 0) {
      std::fprintf(stderr, "%s\n", value.c_str());
      failed_ = true;
    }
  }

  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList&, const void*, int, int) override {
    if (type != PET_VIEW) return;
    ++software_;
    std::fprintf(stderr, "CEF devolveu pixels de software em vez de textura compartilhada\n");
    failed_ = true;
  }

  void OnAcceleratedPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList&,
                          const CefAcceleratedPaintInfo& info) override {
    ++painted_;
    if (type != PET_VIEW || !paint_pending_ || Done()) return;
    ComPtr<ID3D11Texture2D> texture;
    const HRESULT opened = device_->OpenSharedResource1(info.shared_texture_handle, IID_PPV_ARGS(&texture));
    if (FAILED(opened)) {
      Error("OpenSharedResource1", opened);
      return;
    }
    D3D11_TEXTURE2D_DESC desc = {};
    texture->GetDesc(&desc);
    if (desc.Width != static_cast<UINT>(width_) || desc.Height != static_cast<UINT>(height_ + kMarkerRows) ||
        desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
      Error("formato da textura CEF", E_INVALIDARG);
      return;
    }
    if (!owned_ && !InitSharedTexture(desc)) return;
    const HRESULT acquired = mutex_->AcquireSync(0, 1000);
    if (acquired != S_OK) {
      Error("AcquireSync D3D11", acquired);
      return;
    }
    context_->CopyResource(owned_.Get(), texture.Get());
    const HRESULT released = mutex_->ReleaseSync(1);
    if (FAILED(released)) {
      Error("ReleaseSync D3D11", released);
      return;
    }
    context_->Flush();
    VulkanPixelProbe::Markers markers;
    try {
      markers = vulkan_.CopyFrame();
    } catch (const std::exception& e) {
      std::fprintf(stderr, "leitura Vulkan: %s\n", e.what());
      failed_ = true;
      return;
    }
    if (markers.seek != ExpectedPixel()) {
      std::fprintf(stderr, "pintura anterior ao seek %d: BGRA %u %u %u %u\n", captured_,
                   markers.seek[0], markers.seek[1], markers.seek[2], markers.seek[3]);
      return;
    }
    const auto [blue, green, red, alpha] = markers.alpha;
    if (blue != 24 || green != 48 || red != 96 || (alpha != 127 && alpha != 128)) {
      std::fprintf(stderr, "alfa da textura CEF inesperado: BGRA %u %u %u %u\n",
                   markers.alpha[0], markers.alpha[1], markers.alpha[2], markers.alpha[3]);
      failed_ = true;
      return;
    }
    if (!native_render_ || (trace_ && captured_ < 16)) std::printf("frame %d Vulkan %dx%d BGRA %u %u %u %u\n", captured_, width_, height_,
                                    markers.seek[0], markers.seek[1], markers.seek[2], markers.seek[3]);
    Filter(true);
  }

  void BeginFrame() {
    if (browser_ && !Done()) {
      ++ticks_;
      browser_->GetHost()->SendExternalBeginFrame();
    }
  }

  void Close() { if (browser_) browser_->GetHost()->CloseBrowser(true); }
  bool Closed() const { return !browser_; }
  bool Done() const { return captured_ == total_ || failed_; }
  bool Succeeded() const { return captured_ == total_ && !failed_ && software_ == 0; }
  int software_frames() const { return software_; }
  int captured() const { return captured_; }
  int textures() const { return textures_; }
  bool TimedOut() const { return Clock::now() - last_capture_ >= std::chrono::seconds(30); }
  void ReportTimeout() const {
    std::fprintf(stderr, "CEF sem quadro novo: frame %d, fundo=%d, scan=%d, BeginFrames=%d, paints=%d, aguardando=%d\n",
                 captured_, background_pending_, scan_, ticks_, painted_, paint_pending_);
  }
  void Finish() {
    if (!Succeeded() || scan_) return;
    try {
      vulkan_.Finish(captured_);
      std::printf("libplacebo Vulkan=%d\n", captured_);
    } catch (const std::exception& e) {
      std::fprintf(stderr, "drenagem libplacebo: %s\n", e.what());
      failed_ = true;
    }
  }

 private:
  void Filter(bool new_texture) {
    try {
      if (background_pending_) {
        vulkan_.BackgroundFrame();
        background_pending_ = false;
        paint_pending_ = false;
        last_capture_ = Clock::now();
        std::puts("fundo HTML Vulkan=1");
        auto frame = browser_->GetMainFrame();
        frame->ExecuteJavaScript("document.getElementById('ff-cef-background').remove();"
                                 "document.getElementById('composition').style.visibility='visible';",
                                 frame->GetURL(), 0);
        Seek();
        return;
      }
      vulkan_.FilterFrame(captured_);
    } catch (const std::exception& e) {
      std::fprintf(stderr, "entrada libplacebo no frame %d: %s\n", captured_, e.what());
      failed_ = true;
      return;
    }
    if (new_texture) ++textures_;
    std::fflush(stdout);
    ++captured_;
    last_capture_ = Clock::now();
    paint_pending_ = false;
    if (!Done()) Seek();
  }

  std::array<uint8_t, 4> ExpectedPixel() const {
    if (background_pending_) return {201, 204, 43, 255};
    return {static_cast<uint8_t>(224 - (captured_ * 7) % 128),
            static_cast<uint8_t>(64 + captured_ / 128 % 128),
            static_cast<uint8_t>(32 + captured_ % 128), 255};
  }

  void RequestPaint() {
    paint_pending_ = true;
    auto frame = browser_->GetMainFrame();
    const auto marker = ExpectedPixel();
    const std::string color = "rgb(" + std::to_string(marker[2]) + "," +
        std::to_string(marker[1]) + "," + std::to_string(marker[0]) + ")";
    frame->ExecuteJavaScript(
        std::string("document.getElementById('ff-cef-probe-mark').style.background='") + color + "'",
        frame->GetURL(), 0);
  }

  bool InitSharedTexture(D3D11_TEXTURE2D_DESC desc) {
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    HRESULT hr = device_->CreateTexture2D(&desc, nullptr, owned_.GetAddressOf());
    if (FAILED(hr)) return Error("CreateTexture2D", hr);
    hr = owned_.As(&mutex_);
    if (FAILED(hr)) return Error("IDXGIKeyedMutex", hr);
    ComPtr<IDXGIDevice> dxgi_device;
    hr = device_.As(&dxgi_device);
    if (FAILED(hr)) return Error("IDXGIDevice", hr);
    ComPtr<IDXGIAdapter> adapter;
    hr = dxgi_device->GetAdapter(adapter.GetAddressOf());
    if (FAILED(hr)) return Error("GetAdapter", hr);
    DXGI_ADAPTER_DESC adapter_desc{};
    hr = adapter->GetDesc(&adapter_desc);
    if (FAILED(hr)) return Error("GetDesc", hr);
    ComPtr<IDXGIResource1> resource;
    hr = owned_.As(&resource);
    if (FAILED(hr)) return Error("IDXGIResource1", hr);
    HANDLE handle = nullptr;
    hr = resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &handle);
    if (FAILED(hr)) return Error("CreateSharedHandle", hr);
    try {
      vulkan_.Import(handle, adapter_desc.AdapterLuid, desc.Width, desc.Height,
                    static_cast<uint32_t>(height_), time_base_);
    } catch (const std::exception& e) {
      std::fprintf(stderr, "importação Vulkan: %s\n", e.what());
      failed_ = true;
    }
    CloseHandle(handle);
    return !failed_;
  }

  bool Error(const char* operation, HRESULT value) {
    std::fprintf(stderr, "%s 0x%08lx\n", operation, static_cast<unsigned long>(value));
    failed_ = true;
    return false;
  }

  void Seek() {
    auto frame = browser_->GetMainFrame();
    char timestamp[32]{};
    std::snprintf(timestamp, sizeof(timestamp), "%.17g", step_ms_ * captured_);
    const std::string deliver = scan_
        ? "delete state.signature;document.title='ff:meta:" + std::to_string(captured_) + ":'+JSON.stringify(state);"
        : "const same=state.signature!==undefined&&state.signature===window.__ffCefProbeSignature;"
          "window.__ffCefProbeSignature=state.signature;"
          "document.title=(same?'ff:reuse:':'ff:seek:')+" + std::to_string(captured_) + ";";
    // O snapshot de estilos faz o flush de layout. Só a entrega de uma textura precisa do paint.
    const char* paint = scan_ ? "" : "await page.__ff.settle();";
    frame->ExecuteJavaScript(
        std::string("(async()=>{try{const page=window.__ffProbeComposition;await page.__ff.ready;await page.__ff.seek(") + timestamp +
        ");" + paint +
        "const state=await page.__ffCefProbeInspect();if(state.error)throw Error(state.error);" + deliver +
        "}catch(e){document.title='ff:error:'+e.message;}})()", frame->GetURL(), 0);
  }

  const int width_;
  const int height_;
  const int total_;
  const AVRational time_base_;
  const double step_ms_;
  CefRefPtr<CefBrowser> browser_;
  ComPtr<ID3D11Device1> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11Texture2D> owned_;
  ComPtr<IDXGIKeyedMutex> mutex_;
  VulkanPixelProbe vulkan_;
  Clock::time_point last_capture_ = Clock::now();
  int captured_ = 0;
  int textures_ = 0;
  int software_ = 0;
  int ticks_ = 0;
  bool paint_pending_ = false;
  int painted_ = 0;
  bool failed_ = false;
  bool native_render_ = false;
  bool background_pending_ = false;
  bool scan_ = false;
  const bool trace_ = GetEnvironmentVariableW(L"FRANKFRAMES_CEF_TRACE", nullptr, 0) != 0;

  IMPLEMENT_REFCOUNTING(Probe);
};

int main(int argc, char** argv) {
  const CefMainArgs args(GetModuleHandle(nullptr));
  CefRefPtr<GpuApp> app = new GpuApp();
  const int sub = CefExecuteProcess(args, app, nullptr);
  if (sub >= 0) return sub;
  if (argc != 7 && argc != 8) {
    std::fprintf(stderr, "ff-cef-probe URL largura altura frames fps-num fps-den [cef.plan|--scan]\n");
    return 2;
  }
  const int width = std::atoi(argv[2]), height = std::atoi(argv[3]), count = std::atoi(argv[4]);
  const int num = std::atoi(argv[5]), den = std::atoi(argv[6]);
  if (width < 4 || height < 4 || count <= 0 || count > 16384 || num <= 0 || den <= 0) return 2;

  CefSettings settings;
  settings.no_sandbox = true;
  settings.windowless_rendering_enabled = true;
  settings.background_color = 0;
  settings.log_severity = LOGSEVERITY_WARNING;
  if (!CefInitialize(args, settings, app, nullptr)) return 3;

  CefRefPtr<Probe> probe = new Probe(width, height, count, {den, num});
  if (argc == 8) {
    try {
      if (std::string(argv[7]) == "--scan") probe->SetScan();
      else probe->SetRenderPlan(ff::LoadRenderPlan(argv[7]));
    } catch (const std::exception& e) {
      std::fprintf(stderr, "%s\n", e.what());
      CefShutdown();
      return 2;
    }
  }
  if (!probe->InitGpu()) { CefShutdown(); return 4; }
  CefWindowInfo window;
  window.SetAsWindowless(nullptr);
  window.shared_texture_enabled = true;
  window.external_begin_frame_enabled = true;
  CefBrowserSettings browser_settings;
  browser_settings.windowless_frame_rate = 60;
  if (!CefBrowserHost::CreateBrowserSync(window, probe, argv[1], browser_settings, nullptr, nullptr)) {
    CefShutdown();
    return 5;
  }

  const auto start = Clock::now();
  auto next = start;
  while (!probe->Done() && !probe->TimedOut()) {
    CefDoMessageLoopWork();
    const auto now = Clock::now();
    if (now >= next) {
      probe->BeginFrame();
      next = now + std::chrono::milliseconds(16);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  if (!probe->Done()) probe->ReportTimeout();
  probe->Finish();
  const double seconds = std::chrono::duration<double>(Clock::now() - start).count();
  probe->Close();
  const auto closed_deadline = Clock::now() + std::chrono::seconds(5);
  while (!probe->Closed() && Clock::now() < closed_deadline) {
    CefDoMessageLoopWork();
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  if (!probe->Closed()) return 6;
  CefShutdown();
  std::printf("frames=%d texturas=%d software=%d segundos=%.3f\n",
              probe->captured(), probe->textures(), probe->software_frames(), seconds);
  return probe->Succeeded() ? 0 : 7;
}

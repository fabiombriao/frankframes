// FrankFrames — proprietário. Ver LICENSE na raiz.
#pragma once

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
}

namespace ff {

inline void CheckAv(int result, const char* operation) {
  if (result >= 0) return;
  char message[AV_ERROR_MAX_STRING_SIZE]{};
  av_strerror(result, message, sizeof(message));
  throw std::runtime_error(std::string(operation) + ": " + message);
}

inline void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

struct PlanSource {
  std::string label;
  std::string path;
};

struct RenderPlan {
  std::string output;
  std::string graph;
  int64_t rate = 0;
  bool background = false;
  std::vector<PlanSource> sources;
};

inline RenderPlan LoadRenderPlan(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  Require(file.good(), "não foi possível abrir o plano CEF");
  auto line = [&]() {
    std::string value;
    Require(static_cast<bool>(std::getline(file, value)), "plano CEF truncado");
    return value;
  };
  Require(line() == "frankframes-cef-v1", "versão do plano CEF inválida");
  RenderPlan plan;
  plan.output = line();
  plan.rate = std::stoll(line());
  const std::string background = line();
  Require(background == "0" || background == "1", "fundo do plano CEF inválido");
  plan.background = background == "1";
  const int count = std::stoi(line());
  Require(!plan.output.empty() && plan.rate > 0 && count > 0 && count <= 4096, "plano CEF inválido");
  for (int i = 0; i < count; ++i) {
    PlanSource src;
    src.label = line();
    src.path = line();
    Require(!src.path.empty() && !src.label.empty(), "fonte do plano CEF inválida");
    plan.sources.push_back(std::move(src));
  }
  plan.graph.assign(std::istreambuf_iterator<char>(file), {});
  Require(!plan.graph.empty(), "grafo CEF vazio");
  return plan;
}

class Input {
 public:
  Input() = default;
  Input(const Input&) = delete;
  ~Input() {
    av_frame_free(&frame);
    av_packet_free(&packet_);
    avcodec_free_context(&decoder_);
    avformat_close_input(&demux_);
  }

  void Open(const PlanSource& source, AVBufferRef* device) {
    CheckAv(avformat_open_input(&demux_, source.path.c_str(), nullptr, nullptr), "abertura da fonte de vídeo");
    CheckAv(avformat_find_stream_info(demux_, nullptr), "informações da fonte de vídeo");
    const AVCodec* codec = nullptr;
    index_ = av_find_best_stream(demux_, AVMEDIA_TYPE_VIDEO, -1, -1, &codec, 0);
    CheckAv(index_, "stream de vídeo");
    stream = demux_->streams[index_];
    decoder_ = avcodec_alloc_context3(codec);
    frame = av_frame_alloc();
    packet_ = av_packet_alloc();
    Require(decoder_ && frame && packet_, "alocação da fonte de vídeo");
    CheckAv(avcodec_parameters_to_context(decoder_, stream->codecpar), "parâmetros do decoder");
    decoder_->pkt_timebase = stream->time_base;
    decoder_->thread_count = 2;
    decoder_->hw_device_ctx = av_buffer_ref(device);
    Require(decoder_->hw_device_ctx, "referência ao dispositivo do decoder");
    decoder_->get_format = [](AVCodecContext*, const AVPixelFormat* formats) {
      for (; *formats != AV_PIX_FMT_NONE; ++formats) if (*formats == AV_PIX_FMT_VULKAN) return *formats;
      return AV_PIX_FMT_NONE;
    };
    CheckAv(avcodec_open2(decoder_, codec, nullptr), "abertura do decoder");
    Require(Next(), "fonte de vídeo sem frames");
    std::fprintf(stdout, "decoder Vulkan %s\n", source.label.c_str());
  }

  bool Next() {
    av_frame_unref(frame);
    for (;;) {
      const int got = avcodec_receive_frame(decoder_, frame);
      if (got == 0) {
        Require(frame->format == AV_PIX_FMT_VULKAN && frame->hw_frames_ctx, "decoder não produziu superfície Vulkan");
        Require(frame->best_effort_timestamp != AV_NOPTS_VALUE, "frame decodificado sem timestamp");
        // Como -display_rotation 0 no caminho CLI: o grafo aplica a rotação de exibição uma vez.
        av_frame_remove_side_data(frame, AV_FRAME_DATA_DISPLAYMATRIX);
        frame->pts = frame->best_effort_timestamp -
            (stream->start_time == AV_NOPTS_VALUE ? 0 : stream->start_time);
        return true;
      }
      if (got == AVERROR_EOF) return false;
      Require(got == AVERROR(EAGAIN) && !flushed_, "decoder não aceitou a drenagem");
      do {
        const int read = av_read_frame(demux_, packet_);
        if (read == AVERROR_EOF) {
          CheckAv(avcodec_send_packet(decoder_, nullptr), "drenagem do decoder");
          flushed_ = true;
          break;
        }
        CheckAv(read, "leitura do vídeo");
        const bool video = packet_->stream_index == index_;
        const int sent = video ? avcodec_send_packet(decoder_, packet_) : 0;
        av_packet_unref(packet_);
        CheckAv(sent, "pacote do decoder");
        if (video) break;
      } while (true);
    }
  }

  bool FeedIfRequested() {
    if (closed_ || av_buffersrc_get_nb_failed_requests(buffer) == 0) return false;
    // O primeiro frame já foi lido para definir as propriedades da fonte do filtro.
    if (!first_ && !Next()) {
      CheckAv(av_buffersrc_close(buffer, AV_NOPTS_VALUE, 0), "fim da fonte de vídeo");
      closed_ = true;
      return true;
    }
    first_ = false;
    CheckAv(av_buffersrc_add_frame_flags(buffer, frame, 0), "frame da fonte de vídeo");
    return true;
  }

  AVStream* stream = nullptr;
  AVFrame* frame = nullptr;
  AVFilterContext* buffer = nullptr;

 private:
  AVFormatContext* demux_ = nullptr;
  AVCodecContext* decoder_ = nullptr;
  AVPacket* packet_ = nullptr;
  int index_ = -1;
  bool first_ = true;
  bool flushed_ = false;
  bool closed_ = false;
};

class RenderGraph {
 public:
  explicit RenderGraph(RenderPlan plan) : plan_(std::move(plan)) {}
  RenderGraph(const RenderGraph&) = delete;
  ~RenderGraph() {
    av_packet_free(&packet_);
    av_frame_free(&frame_);
    av_frame_free(&background_frame_);
    avcodec_free_context(&encoder_);
    if (mux_) {
      if (mux_->pb) avio_closep(&mux_->pb);
      avformat_free_context(mux_);
    }
    avfilter_graph_free(&graph_);
  }

  void Init(AVBufferRef* device, AVBufferRef* overlay, AVRational time_base) {
    time_base_ = time_base;
    graph_ = avfilter_graph_alloc();
    frame_ = av_frame_alloc();
    packet_ = av_packet_alloc();
    Require(graph_ && frame_ && packet_, "alocação do grafo CEF");
    graph_->nb_threads = 4;
    std::map<std::string, AVFilterContext*> named;
    for (const auto& spec : plan_.sources) {
      inputs_.push_back(std::make_unique<Input>());
      auto& input = *inputs_.back();
      input.Open(spec, device);
      const auto* first = input.frame;
      input.buffer = Buffer(spec.label.c_str(), first->format, first->width, first->height,
                            input.stream->time_base, input.stream->avg_frame_rate,
                            first->sample_aspect_ratio, first->hw_frames_ctx, first->colorspace,
                            first->color_range, first->alpha_mode);
      Require(named.emplace(spec.label, input.buffer).second, "nome de fonte repetido");
    }
    const auto* surface = reinterpret_cast<const AVHWFramesContext*>(overlay->data);
    const auto html = [&](const char* label) {
      auto* source = Buffer(label, AV_PIX_FMT_VULKAN, surface->width, surface->height, time_base,
                            av_inv_q(time_base), {1, 1}, overlay, AVCOL_SPC_RGB,
                            AVCOL_RANGE_JPEG, AVALPHA_MODE_PREMULTIPLIED);
      Require(named.emplace(label, source).second, "nome de fonte CEF repetido");
      return source;
    };
    overlay_ = html("cefhtml");
    if (plan_.background) background_ = html("cefbackground");
    ApplyGraph(device, named);
    OpenOutput();
  }

  void SubmitBackground(AVFrame* frame) {
    Require(background_ && !background_frame_, "fundo CEF inesperado");
    background_frame_ = av_frame_clone(frame);
    Require(background_frame_, "referência da textura do fundo CEF");
  }

  void Submit(AVFrame* frame) {
    if (background_) {
      Require(background_frame_, "fundo CEF não foi enviado");
      background_frame_->pts = frame->pts;
      background_frame_->duration = frame->duration;
      CheckAv(av_buffersrc_write_frame(background_, background_frame_), "entrada do fundo CEF");
    }
    CheckAv(av_buffersrc_write_frame(overlay_, frame), "entrada da camada CEF");
    Drain();
  }

  void Finish(int64_t expected) {
    CheckAv(av_buffersrc_close(overlay_, expected, 0), "fim da camada CEF");
    if (background_) {
      CheckAv(av_buffersrc_close(background_, expected, 0), "fim do fundo CEF");
    }
    Drain();
    Require(encoded_ == expected, "contagem de quadros do MP4 Vulkan diferente da composição");
    CheckAv(avcodec_send_frame(encoder_, nullptr), "drenagem do encoder Vulkan");
    WritePackets();
    CheckAv(av_write_trailer(mux_), "trailer do MP4 Vulkan");
    CheckAv(avio_closep(&mux_->pb), "fechamento do MP4 Vulkan");
    std::printf("MP4 Vulkan frames=%lld\n", static_cast<long long>(encoded_));
  }

 private:
  AVFilterContext* Buffer(const char* name, int format, int w, int h, AVRational time_base,
                         AVRational rate, AVRational aspect, AVBufferRef* frames,
                         AVColorSpace space, AVColorRange range, AVAlphaMode alpha) {
    auto* source = avfilter_graph_alloc_filter(graph_, avfilter_get_by_name("buffer"), name);
    auto* params = av_buffersrc_parameters_alloc();
    if (!source || !params) {
      av_free(params);
      throw std::runtime_error("alocação de buffer do filtro");
    }
    params->format = format;
    params->width = w;
    params->height = h;
    params->time_base = time_base;
    params->frame_rate = rate;
    params->sample_aspect_ratio = aspect.num ? aspect : AVRational{1, 1};
    params->hw_frames_ctx = frames;
    params->color_space = space;
    params->color_range = range;
    params->alpha_mode = alpha;
    const int applied = av_buffersrc_parameters_set(source, params);
    av_free(params);
    CheckAv(applied, "parâmetros de buffer do filtro");
    CheckAv(avfilter_init_str(source, nullptr), "inicialização de buffer do filtro");
    return source;
  }

  void ApplyGraph(AVBufferRef* device, std::map<std::string, AVFilterContext*>& named) {
    AVFilterGraphSegment* segment = nullptr;
    AVFilterInOut* in = nullptr;
    AVFilterInOut* out = nullptr;
    const auto release = [&]() {
      avfilter_inout_free(&in);
      avfilter_inout_free(&out);
      avfilter_graph_segment_free(&segment);
    };
    try {
      CheckAv(avfilter_graph_segment_parse(graph_, plan_.graph.c_str(), 0, &segment), "leitura do grafo");
      CheckAv(avfilter_graph_segment_create_filters(segment, 0), "criação dos filtros");
      for (size_t i = 0; i < graph_->nb_filters; ++i) {
        auto* filter = graph_->filters[i];
        if ((filter->filter->flags & AVFILTER_FLAG_HWDEVICE) != 0) {
          filter->hw_device_ctx = av_buffer_ref(device);
          Require(filter->hw_device_ctx, "referência ao dispositivo do filtro");
        }
      }
      CheckAv(avfilter_graph_segment_apply_opts(segment, 0), "opções dos filtros");
      CheckAv(avfilter_graph_segment_init(segment, 0), "inicialização dos filtros");
      CheckAv(avfilter_graph_segment_link(segment, 0, &in, &out), "ligações do grafo");
      for (auto* port = in; port; port = port->next) {
        Require(port->name, "entrada sem nome no grafo");
        auto match = named.find(port->name);
        Require(match != named.end(), "entrada do grafo sem fonte");
        CheckAv(avfilter_link(match->second, 0, port->filter_ctx, port->pad_idx), "fonte → entrada do grafo");
        named.erase(match);
      }
      Require(named.empty() && out && !out->next && out->name && std::string(out->name) == "out",
              "o grafo deve consumir as fontes e produzir apenas [out]");
      CheckAv(avfilter_graph_create_filter(&sink_, avfilter_get_by_name("buffersink"), "encoded", nullptr,
                                           nullptr, graph_), "saída do filtro");
      CheckAv(avfilter_link(out->filter_ctx, out->pad_idx, sink_, 0), "grafo → encoder");
      CheckAv(avfilter_graph_config(graph_, nullptr), "negociação do grafo Vulkan");
    } catch (...) {
      release();
      throw;
    }
    release();
  }

  void OpenOutput() {
    CheckAv(avformat_alloc_output_context2(&mux_, nullptr, "mp4", plan_.output.c_str()), "alocação do MP4");
    const auto* codec = avcodec_find_encoder_by_name("av1_vulkan");
    Require(codec && av_buffersink_get_format(sink_) == AV_PIX_FMT_VULKAN, "saída do grafo não é AV1 Vulkan");
    encoder_ = avcodec_alloc_context3(codec);
    Require(encoder_, "alocação do encoder Vulkan");
    encoder_->hw_frames_ctx = av_buffer_ref(av_buffersink_get_hw_frames_ctx(sink_));
    Require(encoder_->hw_frames_ctx, "saída do filtro sem contexto Vulkan");
    encoder_->pix_fmt = AV_PIX_FMT_VULKAN;
    encoder_->width = av_buffersink_get_w(sink_);
    encoder_->height = av_buffersink_get_h(sink_);
    encoder_->time_base = time_base_;
    encoder_->framerate = av_inv_q(time_base_);
    encoder_->sample_aspect_ratio = av_buffersink_get_sample_aspect_ratio(sink_);
    encoder_->colorspace = AVCOL_SPC_SMPTE170M;
    encoder_->color_range = AVCOL_RANGE_MPEG;
    encoder_->color_primaries = AVCOL_PRI_BT709;
    encoder_->color_trc = AVCOL_TRC_IEC61966_2_1;
    encoder_->max_b_frames = 0;
    encoder_->bit_rate = plan_.rate;
    encoder_->rc_max_rate = plan_.rate * 2;
    encoder_->rc_buffer_size = static_cast<int>(plan_.rate * 4);
    if ((mux_->oformat->flags & AVFMT_GLOBALHEADER) != 0) encoder_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    AVDictionary* options = nullptr;
    av_dict_set(&options, "tune", "hq", 0);
    av_dict_set(&options, "rc_mode", "vbr", 0);
    const int opened = avcodec_open2(encoder_, codec, &options);
    av_dict_free(&options);
    CheckAv(opened, "abertura do encoder AV1 Vulkan");
    out_ = avformat_new_stream(mux_, nullptr);
    Require(out_, "stream MP4");
    out_->time_base = time_base_;
    out_->avg_frame_rate = av_inv_q(time_base_);
    CheckAv(avcodec_parameters_from_context(out_->codecpar, encoder_), "parâmetros AV1 Vulkan do MP4");
    CheckAv(avio_open(&mux_->pb, plan_.output.c_str(), AVIO_FLAG_WRITE), "arquivo MP4 Vulkan");
    CheckAv(av_opt_set(mux_->priv_data, "video_track_timescale", "90000", 0), "timescale MP4");
    CheckAv(avformat_write_header(mux_, nullptr), "cabeçalho do MP4 Vulkan");
  }

  void Drain() {
    for (;;) {
      const int got = av_buffersink_get_frame(sink_, frame_);
      if (got == AVERROR_EOF) return;
      if (got == AVERROR(EAGAIN)) {
        bool fed = false;
        for (auto& input : inputs_) fed = input->FeedIfRequested() || fed;
        if (!fed) return;
        continue;
      }
      CheckAv(got, "saída Vulkan do filtro");
      const auto pts = av_rescale_q(frame_->pts, av_buffersink_get_time_base(sink_), time_base_);
      Require(frame_->format == AV_PIX_FMT_VULKAN && frame_->hw_frames_ctx && pts == encoded_,
              "frame do filtro fora de Vulkan ou PTS fora de sequência");
      frame_->pts = pts;
      frame_->duration = 1;
      CheckAv(avcodec_send_frame(encoder_, frame_), "frame do encoder AV1 Vulkan");
      av_frame_unref(frame_);
      ++encoded_;
      WritePackets();
    }
  }

  void WritePackets() {
    for (;;) {
      const int got = avcodec_receive_packet(encoder_, packet_);
      if (got == AVERROR(EAGAIN) || got == AVERROR_EOF) return;
      CheckAv(got, "pacote AV1 Vulkan");
      av_packet_rescale_ts(packet_, time_base_, out_->time_base);
      packet_->stream_index = out_->index;
      CheckAv(av_interleaved_write_frame(mux_, packet_), "pacote do MP4");
    }
  }

  RenderPlan plan_;
  AVRational time_base_{};
  std::vector<std::unique_ptr<Input>> inputs_;
  AVFilterGraph* graph_ = nullptr;
  AVFilterContext* overlay_ = nullptr;
  AVFilterContext* background_ = nullptr;
  AVFilterContext* sink_ = nullptr;
  AVCodecContext* encoder_ = nullptr;
  AVFrame* frame_ = nullptr;
  AVFrame* background_frame_ = nullptr;
  AVPacket* packet_ = nullptr;
  AVFormatContext* mux_ = nullptr;
  AVStream* out_ = nullptr;
  int64_t encoded_ = 0;
};

}  // namespace ff

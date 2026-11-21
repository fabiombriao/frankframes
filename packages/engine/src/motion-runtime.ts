// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Runtime do motion (docs/contract.md §7b.12). Roda DENTRO da página, depois do relógio.
 *
 * Lê `data-ff-motion` (escrito pelo compilador) e cria uma animação WAAPI por propriedade.
 * Nenhuma decisão de tempo é tomada aqui: `d` e `n` já vêm resolvidos, e o relógio
 * sincroniza a animação como qualquer outra (`currentTime = agora − data-ff-comp-start`).
 * Por isso seek em qualquer ordem dá o mesmo frame.
 *
 * As propriedades `--ff-*` e a tabela de posse vêm do contrato: fonte única.
 */
import { MOTION_PROPERTIES, OWNED_BY_PROP } from "@frankframes/contract";

const PROPERTIES = JSON.stringify(MOTION_PROPERTIES);
const OWNED = JSON.stringify(OWNED_BY_PROP);

export const MOTION_SOURCE = `(() => {
  const PROPERTIES = ${PROPERTIES};
  const OWNED = ${OWNED};
  const clock = window.__ff;
  if (!clock || typeof clock.prepare !== "function") {
    throw new Error("E_MOTION_RUNTIME: relógio virtual ausente; o motion precisa rodar depois dele");
  }

  const label = (element) => {
    const id = element.getAttribute("data-clip-id") || element.id;
    return "<" + element.tagName.toLowerCase() + (id ? ' id="' + id + '"' : "") + ">";
  };
  const camel = (prop) => (prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));

  let registered = false;
  const registerProperties = () => {
    if (registered) return;
    registered = true;
    for (const item of PROPERTIES) {
      CSS.registerProperty({ name: item.name, syntax: item.syntax, inherits: false, initialValue: item.initial });
    }
  };

  // Animação CSS do autor numa propriedade que o motion possui: dois donos para o mesmo valor.
  const assertNoConflict = (element, spec) => {
    const owned = new Set();
    for (const item of spec.a) if (OWNED[item.p] !== undefined) owned.add(camel(OWNED[item.p]));
    if (owned.size === 0) return;
    for (const animation of element.getAnimations()) {
      const effect = animation.effect;
      if (!effect || typeof effect.getKeyframes !== "function") continue;
      for (const frame of effect.getKeyframes()) {
        for (const name of owned) {
          if (name in frame && frame[name] !== undefined && frame[name] !== "auto") {
            throw new Error(
              "E_MOTION_CONFLICT: " + label(element) + " tem animação CSS em '" + name + "', propriedade que o motion possui" +
                " (hint: remova a animação do autor ou use outra propriedade)",
            );
          }
        }
      }
    }
  };

  const apply = (element) => {
    let spec;
    try {
      spec = JSON.parse(element.getAttribute("data-ff-motion"));
    } catch (error) {
      throw new Error("E_MOTION_RUNTIME: data-ff-motion inválido em " + label(element) + ": " + error.message);
    }
    if (!spec || spec.v !== 1 || !Array.isArray(spec.a) || !Array.isArray(spec.s)) {
      throw new Error("E_MOTION_RUNTIME: data-ff-motion com versão ou formato desconhecido em " + label(element));
    }
    assertNoConflict(element, spec);
    for (const binding of spec.s) element.style.setProperty(binding[0], binding[1]);
    for (const item of spec.a) {
      const frames = item.k.map((key) => ({ offset: key[0], [camel(item.p)]: String(key[1]), easing: key[2] === null ? "linear" : key[2] }));
      const animation = element.animate(frames, { delay: item.d, duration: item.n, fill: "both", easing: "linear", id: "ff-motion" });
      animation.pause();
    }
  };

  // <video> nunca é animado: o Chrome não o decodifica e o shim de mídia o troca por <img>. O movimento
  // vai para essa <img> (attach), que o shim cria no primeiro seek. Sem o shim, o movimento sumiria.
  const assertShimmed = (element) => {
    const shim = window.__ffMediaShim;
    const id = element.getAttribute("data-clip-id");
    if (!shim || id === null || !shim.has(id)) {
      throw new Error(
        "E_MOTION_TARGET: " + label(element) + " é <video> sem mídia fora de banda; o motion só chega ao vídeo pela <img> que o substitui" +
          " (hint: renderize pelo FrankFrames, ou aplique o motion num <img> ou num elemento que envolve o vídeo)",
      );
    }
  };

  // Usado pelo shim de mídia: aplica o data-ff-motion copiado do <video> à <img> que o substituiu.
  window.__ffMotion = {
    attach(element) {
      registerProperties();
      apply(element);
    },
  };

  clock.prepare(() => {
    const targets = document.querySelectorAll("[data-ff-motion]");
    if (targets.length === 0) return;
    registerProperties();
    for (const element of targets) {
      if (element.tagName === "VIDEO") assertShimmed(element);
      else apply(element);
    }
  });
})();`;

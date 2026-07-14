import React from "react";
import {
  AbsoluteFill,
  Audio,
  getRemotionEnvironment,
  Img,
  Sequence,
  Series,
  staticFile,
  useCurrentFrame,
} from "remotion";
import {Video} from "@remotion/media";
import {z} from "zod";
import {CLIPS, WINNERS, type Clip} from "../data/nebraska";
import {loadGoogleFont} from "../presets/fonts";

loadGoogleFont("Poppins", "400;600;700;800;900");
loadGoogleFont("JetBrains Mono", "400;700");

// Paleta de marca Patitas Peludas.
const CORAL = "#ec9eb3";
const VINO = "#8b3e64";
const CAFE = "#7b5436";
const CREAM = "#fff6ef";

export const REEL_FPS = 24;
const W = 1080;
const H = 1920;

// El material es 1024x576. Un 9:16 a altura completa mide 324 px de ancho:
// es el recorte mas ancho posible, o sea la mejor calidad alcanzable.
const SRC_W = 1024;
const SRC_H = 576;
const CROP_W_NORM = (SRC_H * (9 / 16)) / SRC_W; // 0.3164
const HALF = CROP_W_NORM / 2;

// La escala que lleva la altura del original a 1920.
const SCALE = H / SRC_H;
const SCALED_W = SRC_W * SCALE;

// Menu desplegable, no texto libre: un `clip` mal escrito o vacio no coincide
// con nada y la entrada queda muerta sin avisar.
const clipSrc = z
  .enum([
    "assets/nebraska01.mp4",
    "assets/nebraska02.mp4",
    "assets/nebraska03.mp4",
  ])
  .default("assets/nebraska02.mp4");

/**
 * Todo esto sale como controles en el panel derecho de Remotion Studio.
 * Mueve un slider y el preview se actualiza en vivo; el boton de guardar
 * escribe los valores de vuelta a Root.tsx.
 */
export const reelSchema = z.object({
  /**
   * El montaje: un corte por entrada, en orden. Es la lista que edita el modo
   * editor (clic en el video), y tambien se puede tocar a mano desde el panel
   * de Studio. Borrar una entrada acorta el reel; la duracion se recalcula
   * sola via `calcReelMetadata`.
   */
  cuts: z
    .array(
      z.object({
        clip: clipSrc,
        /** Segundos DEL CLIP ORIGINAL. */
        startSeconds: z.number().min(0).max(90).step(0.01).default(0),
        endSeconds: z.number().min(0).max(90).step(0.01).default(1),
      }),
    )
    .describe("Cortes del montaje"),
  prizeShots: z
    .array(
      z.object({
        label: z.string().default("nuevo encuadre"),
        clip: clipSrc,
        /** Centro horizontal del recorte: 0 = izquierda, 1 = derecha. */
        cx: z.number().min(0.16).max(0.84).step(0.01).default(0.5),
        /** Segundos DEL CLIP ORIGINAL (los que muestra el editor). */
        start: z.number().min(0).max(90).step(0.01).default(0),
        end: z.number().min(0).max(90).step(0.01).default(0),
      }),
    )
    .describe("Encuadre de los premios"),
  /** Segundos que tarda el encuadre en viajar del vendedor al premio. */
  rampSeconds: z.number().min(0.1).max(1.5).step(0.05),
  musicVolume: z.number().min(0).max(1).step(0.05),
  /**
   * Editor de cortes sobre el preview: clic en el video para seleccionar el
   * corte que estas viendo, o clic en la tira de abajo para saltar a otro.
   * Con uno seleccionado puedes recortarlo, partirlo, moverlo o borrarlo, y
   * cada cambio se guarda solo en Root.tsx. Solo existe en Studio: nunca sale
   * en el render.
   */
  editor: z.boolean(),
});

export type ReelProps = z.infer<typeof reelSchema>;
export type Cut = ReelProps["cuts"][number];


const INTRO_SECONDS = 3;
const OUTRO_SECONDS = 5.5;

const framesOf = (s: number) => Math.round(s * REEL_FPS);

export const INTRO_FRAMES = framesOf(INTRO_SECONDS);
export const OUTRO_FRAMES = framesOf(OUTRO_SECONDS);

/** Los datos de cara van por archivo; los cortes ya solo guardan el nombre. */
const CLIP_BY_SRC = new Map(CLIPS.map((c) => [c.src, c]));
const clipOf = (cut: Cut): Clip => CLIP_BY_SRC.get(cut.clip) ?? CLIPS[0];

export const cutFrames = (c: Cut) => framesOf(c.endSeconds - c.startSeconds);
export const bodyFrames = (cuts: Cut[]) =>
  cuts.reduce((n, c) => n + cutFrames(c), 0);

/** El primer cuadro del reel en que se ve el corte `i`. */
export const cutStartFrame = (cuts: Cut[], i: number) =>
  INTRO_FRAMES + bodyFrames(cuts.slice(0, i));

/**
 * La duracion sale de los cortes, asi que Remotion la tiene que recalcular
 * cada vez que cambian los props. Borra un corte y el reel se acorta solo.
 */
export const calcReelMetadata = ({props}: {props: ReelProps}) => ({
  durationInFrames:
    INTRO_FRAMES + bodyFrames(props.cuts ?? []) + OUTRO_FRAMES,
});

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smoothstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Donde esta la cara del vendedor en el instante `t` del clip original. */
const faceAt = (clip: Clip, t: number) => {
  const pts = clip.face;
  if (pts.length === 0) return 0.69;
  if (t <= pts[0].t) return pts[0].cx;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      const k = (t - a.t) / (b.t - a.t || 1);
      return a.cx + (b.cx - a.cx) * k;
    }
  }
  return pts[pts.length - 1].cx;
};

// --------------------------------------------------------- motor de encuadre
//
// Tres reglas duras, porque sin ellas el encuadre se sentia brusco:
//
// 1. VELOCIDAD MAXIMA. El recorte 9:16 mide 0.316 del ancho original. Un paneo
//    de 1.5 cx/s cruza cinco anchos de encuadre por segundo: es un latigazo,
//    no un movimiento de camara. Se limita a MAX_PAN.
// 2. ENCUADRE ESTABLE. La cara nunca esta quieta. Seguirla literalmente hace
//    que el cuadro tiemble. Se sigue con holgura: solo se mueve si ella se
//    aleja mas de DEADBAND del centro, y entonces la reengancha por el borde.
// 3. UN ENCUADRE POR CORTE. Un premio solo manda si cubre buena parte del
//    corte; si apenas lo roza se ignora. Antes, un premio que empezaba a
//    media toma disparaba un paneo en medio del plano, y cortes vecinos
//    alternaban entre el vendedor y la repisa, que es el parpadeo que se veia.

/** cx por segundo. Un tercio del ancho del encuadre por segundo. */
const MAX_PAN = 0.11;
/** Cuanto puede alejarse la cara del centro antes de que la camara la siga. */
const DEADBAND = 0.05;
/** Un premio manda sobre el corte solo si cubre al menos esto de la toma. */
const MIN_COVERAGE = 0.45;

/** Un corte breve no basta para justificar irse y volver. */
const BRIDGE_SECONDS = 2.5;

type Shot = ReelProps["prizeShots"][number];

/** El premio que manda en este corte, si alguno lo cubre lo suficiente. */
const shotForCut = (cut: Cut, shots: ReelProps["prizeShots"]) => {
  const cutLength = cut.endSeconds - cut.startSeconds;
  let best: Shot | null = null;
  let bestCoverage = MIN_COVERAGE;

  for (const shot of shots) {
    if (shot.clip !== cut.clip) continue;
    const overlap =
      Math.min(shot.end, cut.endSeconds) - Math.max(shot.start, cut.startSeconds);
    const coverage = overlap / cutLength;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      best = shot;
    }
  }
  return best;
};

/**
 * Resuelve el encuadre de TODOS los cortes de una vez, porque la decision de
 * uno depende de sus vecinos.
 *
 * Sin esto el encuadre rebotaba: premio -> vendedor -> premio -> vendedor, en
 * cortes de un segundo. Cada salto era de casi medio cuadro, y encadenados se
 * leian como un error de montaje. Un corte corto atrapado entre dos premios
 * hereda el premio: la camara se queda donde estaba en vez de ir y volver.
 */
export const resolveShots = (cuts: Cut[], shots: ReelProps["prizeShots"]) => {
  const resolved = cuts.map((cut) => shotForCut(cut, shots));

  for (let i = 1; i < resolved.length - 1; i++) {
    if (resolved[i]) continue;
    const prev = resolved[i - 1];
    const next = resolved[i + 1];
    if (!prev || !next) continue;
    // Solo puentea si el hueco es corto y ambos lados miran a lo mismo.
    const cut = cuts[i];
    const length = cut.endSeconds - cut.startSeconds;
    const sameClip =
      cuts[i - 1].clip === cut.clip && cuts[i + 1].clip === cut.clip;
    if (length <= BRIDGE_SECONDS && sameClip && Math.abs(prev.cx - next.cx) < 0.12) {
      resolved[i] = prev;
    }
  }
  return resolved;
};

/**
 * El recorrido completo del encuadre para un corte, cuadro a cuadro.
 * Se calcula de una vez porque el limite de velocidad es acumulativo: cada
 * cuadro depende del anterior.
 */
const cutPath = (cut: Cut, shot: Shot | null, ramp: number) => {
  const clip = clipOf(cut);
  const frames = cutFrames(cut);
  const step = MAX_PAN / REEL_FPS;

  // Objetivo por cuadro, antes de suavizar.
  const targets: number[] = [];
  let held = 0;
  for (let f = 0; f < frames; f++) {
    const t = cut.startSeconds + f / REEL_FPS;
    if (shot) {
      // El premio es un encuadre fijo: el corte entero lo mira.
      targets.push(shot.cx);
      continue;
    }
    const face = faceAt(clip, t);
    if (f === 0) {
      held = face;
    } else if (Math.abs(face - held) > DEADBAND) {
      // Solo reencuadra cuando se sale de la zona muerta, y la reengancha
      // por el borde: asi la camara "respira" en vez de perseguirlo.
      held = face > held ? face - DEADBAND : face + DEADBAND;
    }
    targets.push(held);
  }

  // Entrada suave al encuadre de premio, respetando la velocidad maxima.
  const path: number[] = [];
  let cur = targets[0] ?? 0.5;
  for (let f = 0; f < frames; f++) {
    const want = targets[f];
    const delta = want - cur;
    // Frena cerca del objetivo para que no llegue de golpe.
    const ease = smoothstep(Math.abs(delta) / (MAX_PAN * ramp));
    const move = Math.sign(delta) * Math.min(Math.abs(delta), step * ease);
    cur += move;
    path.push(clamp(cur, HALF, 1 - HALF));
  }
  return path;
};

/** Recorte 9:16 a sangre que sigue al sujeto que toca en cada momento. */
const Reframed: React.FC<{
  cut: Cut;
  shot: Shot | null;
  ramp: number;
}> = ({cut, shot, ramp}) => {
  const frame = useCurrentFrame();

  const path = React.useMemo(() => cutPath(cut, shot, ramp), [cut, shot, ramp]);

  const centre = path[clamp(frame, 0, path.length - 1)] ?? 0.5;
  const left = W / 2 - centre * SCALED_W;

  // Respiracion muy leve; sin zoom fuerte, que aqui cada pixel cuenta.
  const breathe =
    1 + Math.sin((frame / (REEL_FPS * 6)) * Math.PI * 2) * 0.008 + 0.008;

  return (
    <AbsoluteFill style={{overflow: "hidden", backgroundColor: "#000"}}>
      <div
        style={{
          position: "absolute",
          left,
          top: 0,
          width: SCALED_W,
          height: H,
          transform: `scale(${breathe})`,
          transformOrigin: `${centre * SCALED_W}px center`,
        }}
      >
        <Video
          src={staticFile(cut.clip)}
          trimBefore={framesOf(cut.startSeconds)}
          trimAfter={framesOf(cut.endSeconds)}
          volume={1}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "fill",
            translate: "-3px 0px"
          }} />
      </div>
    </AbsoluteFill>
  );
};



// ------------------------------------------------------------------ editor
//
// Un editor de cortes dentro del propio preview. Clic en el video selecciona
// el corte que estas viendo; clic en la tira de abajo salta a cualquier otro.
// Cada boton reescribe los `cuts` de Root.tsx con saveDefaultProps(), que es
// la misma via por la que Studio guarda los sliders: no hay estado paralelo
// que se pueda desincronizar del archivo.
//
// Solo se monta en Studio (`getRemotionEnvironment().isStudio`), asi que no
// hay manera de que se cuele en un render aunque dejes el prop encendido.

/** El id con el que esta registrado en Root.tsx. saveDefaultProps lo necesita. */
export const REEL_ID = "RifaNebraskaReel";

/** Ningun corte baja de aqui: mas corto y el ojo no alcanza a asentarse. */
const MIN_CUT_SECONDS = 0.3;
/** Lo que mueve cada clic en los botones de recorte. */
const NUDGE_SECONDS = 0.1;

const studio = () => import("@remotion/studio");

/** Escribe props en Root.tsx conservando lo que haya sin guardar en el panel. */
const persistProps = async (patch: Partial<ReelProps>) => {
  const {saveDefaultProps} = await studio();
  await saveDefaultProps({
    compositionId: REEL_ID,
    defaultProps: ({unsavedDefaultProps}) => ({...unsavedDefaultProps, ...patch}),
  });
};

const seekTo = async (frame: number) => {
  const {seek} = await studio();
  seek(frame);
};

/** Abre y resalta esa entrada exacta en el panel de props de Studio. */
const showInJson = async (path: (string | number)[]) => {
  const {focusDefaultPropsPath} = await studio();
  focusDefaultPropsPath({path});
};

/**
 * Studio dibuja encima del preview una capa de contornos (los recuadros azules
 * que resaltan el elemento bajo el cursor) con `pointer-events: all`. Vive
 * fuera de la composicion, asi que ningun z-index nuestro la gana: se traga
 * todos los clics y el editor parece muerto.
 *
 * Mientras el editor esta encendido le quitamos los eventos a esa capa — es lo
 * mismo que hace el boton "Hide outlines" de la barra, pero sin que tengas que
 * acordarte de darle. Se revierte solo al apagar el editor.
 */
const useClicksReachTheCanvas = (enabled: boolean) => {
  React.useEffect(() => {
    if (!enabled) return;
    const style = document.createElement("style");
    style.textContent =
      'svg[aria-hidden="true"] polygon {pointer-events: none !important}';
    document.head.appendChild(style);
    return () => style.remove();
  }, [enabled]);
};

const EDITOR_FONT = "'JetBrains Mono', monospace";

const Button: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  tone?: "normal" | "danger";
  children: React.ReactNode;
}> = ({onClick, disabled, tone = "normal", children}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    style={{
      appearance: "none",
      border: "none",
      borderRadius: 10,
      padding: "14px 18px",
      fontFamily: EDITOR_FONT,
      fontSize: 26,
      fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.35 : 1,
      color: tone === "danger" ? "#fff" : "#0b0b0f",
      background: tone === "danger" ? "#e0245e" : CREAM,
    }}
  >
    {children}
  </button>
);

const Row: React.FC<{label: string; children: React.ReactNode}> = ({
  label,
  children,
}) => (
  <div>
    <span style={{color: "#a3a3a3"}}>{label}: </span>
    {children}
  </div>
);

const CutEditor: React.FC<{
  cuts: Cut[];
  shots: ReelProps["prizeShots"];
  selected: number | null;
  onSelect: (i: number | null) => void;
}> = ({cuts, shots, selected, onSelect}) => {
  const frame = useCurrentFrame();
  const undoStack = React.useRef<Cut[][]>([]);

  useClicksReachTheCanvas(true);

  const starts = React.useMemo(() => cuts.map((_, i) => cutStartFrame(cuts, i)), [cuts]);
  const resolved = React.useMemo(() => resolveShots(cuts, shots), [cuts, shots]);

  /** El corte bajo el cursor de reproduccion; null en la entrada o la salida. */
  const playing = React.useMemo(() => {
    const i = starts.findIndex(
      (s, k) => frame >= s && frame < s + cutFrames(cuts[k]),
    );
    return i === -1 ? null : i;
  }, [starts, cuts, frame]);

  const apply = React.useCallback(
    (next: Cut[], focus: number | null) => {
      undoStack.current.push(cuts);
      persistProps({cuts: next});
      onSelect(focus);
      if (focus !== null) seekTo(cutStartFrame(next, focus));
    },
    [cuts, onSelect],
  );

  const undo = React.useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    persistProps({cuts: prev});
    onSelect(null);
  }, [onSelect]);

  const cut = selected === null ? null : cuts[selected];

  // Cuadro del reel en que estas parado dentro del corte seleccionado, si es
  // que el cursor esta dentro de el. Es lo que permite partirlo por aqui.
  const insideSelected = selected !== null && playing === selected;
  const sourceT =
    cut && insideSelected
      ? cut.startSeconds + (frame - starts[selected as number]) / REEL_FPS
      : null;

  const edit = (patch: Partial<Cut>) => {
    if (selected === null || !cut) return;
    const next = cuts.map((c, i) => (i === selected ? {...c, ...patch} : c));
    apply(next, selected);
  };

  const trimStart = (d: number) => {
    if (!cut) return;
    const startSeconds = clamp(
      Number((cut.startSeconds + d).toFixed(2)),
      0,
      cut.endSeconds - MIN_CUT_SECONDS,
    );
    edit({startSeconds});
  };

  const trimEnd = (d: number) => {
    if (!cut) return;
    const endSeconds = Math.max(
      cut.startSeconds + MIN_CUT_SECONDS,
      Number((cut.endSeconds + d).toFixed(2)),
    );
    edit({endSeconds});
  };

  const remove = () => {
    if (selected === null) return;
    const next = cuts.filter((_, i) => i !== selected);
    // Deja seleccionado el corte que ocupa ahora ese hueco, para poder ir
    // borrando en cadena sin tener que volver a apuntar.
    const focus = next.length === 0 ? null : Math.min(selected, next.length - 1);
    apply(next, focus);
  };

  const split = () => {
    if (selected === null || !cut || sourceT === null) return;
    const left = {...cut, endSeconds: Number(sourceT.toFixed(2))};
    const right = {...cut, startSeconds: Number(sourceT.toFixed(2))};
    if (
      left.endSeconds - left.startSeconds < MIN_CUT_SECONDS ||
      right.endSeconds - right.startSeconds < MIN_CUT_SECONDS
    ) {
      return;
    }
    const next = [...cuts];
    next.splice(selected, 1, left, right);
    apply(next, selected);
  };

  const move = (d: -1 | 1) => {
    if (selected === null) return;
    const to = selected + d;
    if (to < 0 || to >= cuts.length) return;
    const next = [...cuts];
    [next[selected], next[to]] = [next[to], next[selected]];
    apply(next, to);
  };

  const canSplit =
    cut !== null &&
    sourceT !== null &&
    sourceT - cut.startSeconds >= MIN_CUT_SECONDS &&
    cut.endSeconds - sourceT >= MIN_CUT_SECONDS;

  const totalSeconds = bodyFrames(cuts) / REEL_FPS;

  // ---- el encuadre de este corte, y su entrada exacta en el JSON ----
  //
  // `resolveShots` devuelve los objetos tal cual salen de `prizeShots`, asi que
  // indexOf da la posicion real en el array: es la ruta que necesita el panel
  // de Studio para resaltar la entrada correcta.
  const shot = selected === null ? null : resolved[selected];
  const shotIndex = shot === null ? -1 : shots.indexOf(shot);

  /**
   * Fija el encuadre de este corte. Nace ya relleno con el clip y los segundos
   * del corte, y con el cx donde esta la cara a mitad de la toma: si lo creas
   * desde el panel de Studio con el boton "+" salen `start` y `end` en 0, la
   * entrada no cubre nada y no hace absolutamente nada, sin avisar de por que.
   *
   * Un corte con encuadre fijo deja de perseguir la cara, que es justo lo que
   * quita el balanceo cuando el rastreo viene nervioso.
   */
  const pinShot = () => {
    if (selected === null || !cut) return;
    const middle = (cut.startSeconds + cut.endSeconds) / 2;
    const cx = clamp(Number(faceAt(clipOf(cut), middle).toFixed(2)), 0.16, 0.84);
    const next = [
      ...shots,
      {
        label: `${cut.clip.replace("assets/", "").replace(".mp4", "")} · corte ${selected + 1}`,
        clip: cut.clip,
        cx,
        start: cut.startSeconds,
        end: cut.endSeconds,
      },
    ];
    persistProps({prizeShots: next});
    showInJson(["prizeShots", next.length - 1]);
  };

  const nudgeShotCx = (d: number) => {
    if (shotIndex === -1) return;
    const next = shots.map((s, i) =>
      i === shotIndex
        ? {...s, cx: clamp(Number((s.cx + d).toFixed(2)), 0.16, 0.84)}
        : s,
    );
    persistProps({prizeShots: next});
  };

  const unpinShot = () => {
    if (shotIndex === -1) return;
    persistProps({prizeShots: shots.filter((_, i) => i !== shotIndex)});
  };

  return (
    <AbsoluteFill style={{pointerEvents: "none"}}>
      {/* Capa de seleccion: un clic en el video toma el corte que se ve. */}
      <div
        onClick={() => onSelect(playing)}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "auto",
          cursor: playing === null ? "default" : "pointer",
        }}
      />

      {/* Ficha del corte seleccionado. */}
      <div
        style={{
          position: "absolute",
          top: 24,
          left: 24,
          right: 24,
          padding: "18px 22px",
          borderRadius: 14,
          background: "rgba(0,0,0,0.82)",
          border: `2px solid ${cut ? CORAL : "rgba(255,255,255,0.18)"}`,
          color: "#fff",
          fontFamily: EDITOR_FONT,
          fontSize: 28,
          lineHeight: 1.5,
          pointerEvents: "auto",
        }}
      >
        {cut === null ? (
          <div style={{color: "#a3a3a3"}}>
            Clic en el video para tomar el corte que estas viendo, o en la tira
            de abajo para ir a otro.
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <b style={{color: CORAL}}>
                corte {(selected as number) + 1}/{cuts.length}
              </b>
              <span style={{color: "#7dd3fc"}}>
                {cut.clip.replace("assets/", "")}
              </span>
            </div>
            <Row label="del clip">
              <b style={{color: "#4ade80"}}>
                {cut.startSeconds.toFixed(2)} → {cut.endSeconds.toFixed(2)}
              </b>
              <span style={{color: "#a3a3a3"}}>
                {"  "}({(cut.endSeconds - cut.startSeconds).toFixed(2)} s)
              </span>
            </Row>
            <Row label="segundo del clip aqui">
              {sourceT === null ? (
                <span style={{color: "#a3a3a3"}}>— (el cursor esta fuera)</span>
              ) : (
                <b style={{color: "#fbbf24"}}>{sourceT.toFixed(2)}</b>
              )}
            </Row>
            <Row label="lo encuadra">
              {shot ? (
                <>
                  <span style={{color: "#f472b6"}}>
                    {shot.label || "(sin nombre)"}
                  </span>
                  <span style={{color: "#a3a3a3"}}>
                    {"  "}· prizeShots[{shotIndex}] · cx {shot.cx.toFixed(2)}
                  </span>
                </>
              ) : (
                <span style={{color: "#4ade80"}}>
                  el rastreo de cara (se mueve solo)
                </span>
              )}
            </Row>

            {/* Encuadre: fijarlo mata el balanceo del rastreo en este corte. */}
            <div
              style={{display: "flex", flexWrap: "wrap", gap: 10, marginTop: 16}}
            >
              {shot ? (
                <>
                  <Button onClick={() => nudgeShotCx(-0.02)}>◀ encuadre</Button>
                  <Button onClick={() => nudgeShotCx(+0.02)}>encuadre ▶</Button>
                  <Button onClick={() => showInJson(["prizeShots", shotIndex])}>
                    ver en el JSON
                  </Button>
                  <Button onClick={unpinShot} tone="danger">
                    quitar encuadre
                  </Button>
                </>
              ) : (
                <Button onClick={pinShot}>fijar encuadre en este corte</Button>
              )}
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                marginTop: 10,
              }}
            >
              <Button onClick={() => trimStart(-NUDGE_SECONDS)}>inicio −.1</Button>
              <Button onClick={() => trimStart(+NUDGE_SECONDS)}>inicio +.1</Button>
              <Button onClick={() => trimEnd(-NUDGE_SECONDS)}>fin −.1</Button>
              <Button onClick={() => trimEnd(+NUDGE_SECONDS)}>fin +.1</Button>
              <Button onClick={split} disabled={!canSplit}>
                partir aqui
              </Button>
              <Button onClick={() => move(-1)} disabled={selected === 0}>
                ◀ mover
              </Button>
              <Button
                onClick={() => move(1)}
                disabled={selected === cuts.length - 1}
              >
                mover ▶
              </Button>
              <Button onClick={remove} tone="danger">
                borrar corte
              </Button>
              <Button
                onClick={undo}
                disabled={undoStack.current.length === 0}
              >
                deshacer
              </Button>
            </div>
          </>
        )}
      </div>

      {/* La tira: un bloque por corte, de ancho proporcional a su duracion. */}
      <div
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          bottom: 24,
          pointerEvents: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 3,
            height: 92,
          }}
        >
          {cuts.map((c, i) => {
            const isSel = i === selected;
            const isPlaying = i === playing;
            return (
              <div
                key={`${c.clip}-${c.startSeconds}-${i}`}
                onClick={() => {
                  onSelect(i);
                  seekTo(starts[i]);
                }}
                title={`${c.clip.replace("assets/", "")}  ${c.startSeconds.toFixed(2)} → ${c.endSeconds.toFixed(2)}`}
                style={{
                  flexGrow: cutFrames(c),
                  flexBasis: 0,
                  minWidth: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: isSel ? CORAL : "rgba(0,0,0,0.72)",
                  color: isSel ? "#3b0d22" : "#fff",
                  border: isPlaying
                    ? `3px solid ${CREAM}`
                    : "3px solid rgba(255,255,255,0.16)",
                  fontFamily: EDITOR_FONT,
                  fontSize: 22,
                  fontWeight: 700,
                }}
              >
                {i + 1}
              </div>
            );
          })}
        </div>
        <div
          style={{
            marginTop: 10,
            textAlign: "center",
            fontFamily: EDITOR_FONT,
            fontSize: 24,
            color: CREAM,
            textShadow: "0 2px 8px rgba(0,0,0,0.9)",
          }}
        >
          {cuts.length} cortes · {totalSeconds.toFixed(1)} s de cuerpo · cada
          cambio se guarda en Root.tsx
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ----------------------------------------------------------------- escenas

/**
 * Tarjeta de entrada. Reconstruye el diseno de la tarjeta de ganadores del
 * video del sorteo: fondo de tienda desenfocado, logo arriba, titular a dos
 * tonos y una fila destacada en vino. Asi entrada y salida hacen juego.
 */
const Intro: React.FC<{musicVolume: number}> = ({musicVolume}) => {
  const frame = useCurrentFrame();
  const k = smoothstep(frame / framesOf(0.5));
  const float = Math.sin((frame / (REEL_FPS * 3)) * Math.PI * 2) * 5;

  const headline: React.CSSProperties = {
    margin: 0,
    fontFamily: "'Poppins', sans-serif",
    fontWeight: 800,
    fontSize: 96,
    lineHeight: 1.0,
    letterSpacing: -1,
    textAlign: "center",
  };

  return (
    <AbsoluteFill style={{backgroundColor: "#1e171d"}}>
      {/* Musica de marca. El arranque de la pista; los fades van en el WAV. */}
      <Audio src={staticFile("assets/music_intro.wav")} volume={musicVolume} />

      {/* Misma cama que la tarjeta final: la tienda, desenfocada y oscura. */}
      <Video
        src={staticFile("assets/nebraska01.mp4")}
        trimBefore={framesOf(2)}
        trimAfter={framesOf(2) + INTRO_FRAMES}
        muted
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(42px) brightness(0.58) saturate(1.25)",
          transform: "scale(1.3)",
        }}
      />

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: 44,
          padding: "0 90px",
          opacity: k,
        }}
      >
        <Img
          src={staticFile("assets/logo.png")}
          style={{
            width: 250,
            objectFit: "contain",
            transform: `translateY(${float}px) scale(${0.9 + k * 0.1})`,
            filter: "drop-shadow(0 14px 34px rgba(0,0,0,0.5))",
          }}
        />

        <div>
          <h1 style={{...headline, color: CREAM}}>RIFA PATITAS</h1>
          <div style={{position: "relative", marginTop: 6}}>
            <h1
              style={{
                ...headline,
                fontSize: 132,
                color: "transparent",
                WebkitTextStroke: `14px ${CREAM}`,
              }}
            >
              2026
            </h1>
            <h1
              style={{
                ...headline,
                fontSize: 132,
                color: CORAL,
                position: "absolute",
                inset: 0,
              }}
            >
              2026
            </h1>
          </div>
        </div>

        {/* Fila destacada, igual que la del ganador del balon. */}
        <div
          style={{
            marginTop: 10,
            background: VINO,
            borderRadius: 30,
            padding: "22px 64px",
            textAlign: "center",
            boxShadow: "0 14px 36px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              fontFamily: "'Poppins', sans-serif",
              fontWeight: 800,
              fontSize: 26,
              letterSpacing: 3,
              color: CORAL,
            }}
          >
            SUCURSAL
          </div>
          <div
            style={{
              fontFamily: "'Poppins', sans-serif",
              fontWeight: 800,
              fontSize: 54,
              color: CREAM,
            }}
          >
            Nebraska
          </div>
        </div>

        <div
          style={{
            marginTop: 26,
            fontFamily: "'Poppins', sans-serif",
            fontWeight: 600,
            fontSize: 30,
            color: CORAL,
          }}
        >
          patitaspeludas.mx
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * Tarjeta de ganadores, con el mismo diseno que la entrada.
 * Los nombres salen de lo que dicta el vendedor en nebraska02.
 */
const Outro: React.FC<{musicVolume: number}> = ({musicVolume}) => {
  const frame = useCurrentFrame();
  const k = smoothstep(frame / framesOf(0.5));
  const float = Math.sin((frame / (REEL_FPS * 3)) * Math.PI * 2) * 5;

  const headline: React.CSSProperties = {
    margin: 0,
    fontFamily: "'Poppins', sans-serif",
    fontWeight: 800,
    fontSize: 82,
    lineHeight: 1.0,
    textAlign: "center",
  };

  return (
    <AbsoluteFill style={{backgroundColor: "#1e171d"}}>
      {/* La misma pista, continuando donde la dejo la entrada. */}
      <Audio src={staticFile("assets/music_outro.wav")} volume={musicVolume} />

      <Video
        src={staticFile("assets/nebraska02.mp4")}
        trimBefore={framesOf(30)}
        trimAfter={framesOf(30) + OUTRO_FRAMES}
        muted
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(42px) brightness(0.58) saturate(1.25)",
          transform: "scale(1.3)",
        }}
      />

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          padding: "0 78px",
          opacity: k,
        }}
      >
        <Img
          src={staticFile("assets/logo.png")}
          style={{
            width: 170,
            objectFit: "contain",
            transform: `translateY(${float}px)`,
            filter: "drop-shadow(0 12px 30px rgba(0,0,0,0.5))",
          }}
        />

        <div style={{marginTop: 26, marginBottom: 42}}>
          <h1 style={{...headline, color: CREAM}}>¡YA TENEMOS</h1>
          <div style={{position: "relative", marginTop: 4}}>
            <h1
              style={{
                ...headline,
                fontSize: 92,
                color: "transparent",
                WebkitTextStroke: `12px ${CREAM}`,
              }}
            >
              GANADORES!
            </h1>
            <h1
              style={{
                ...headline,
                fontSize: 92,
                color: CORAL,
                position: "absolute",
                inset: 0,
              }}
            >
              GANADORES!
            </h1>
          </div>
        </div>

        {/* El premio mayor, destacado como en la tarjeta de referencia. */}
        <div
          style={{
            width: "100%",
            background: VINO,
            borderRadius: 30,
            padding: "20px 40px",
            textAlign: "center",
            boxShadow: "0 14px 36px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              fontFamily: "'Poppins', sans-serif",
              fontWeight: 800,
              fontSize: 26,
              letterSpacing: 3,
              color: CORAL,
            }}
          >
            {WINNERS.headline.prize}
          </div>
          <div
            style={{
              fontFamily: "'Poppins', sans-serif",
              fontWeight: 800,
              fontSize: 56,
              color: CREAM,
            }}
          >
            {WINNERS.headline.name}
          </div>
        </div>

        {WINNERS.rows.map((row, i) => {
          const rowK = smoothstep((frame - framesOf(0.35) - i * 3) / framesOf(0.3));
          return (
            <div
              key={row.name}
              style={{
                width: "100%",
                marginTop: 18,
                background: CREAM,
                borderRadius: 999,
                padding: "20px 38px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 20,
                opacity: rowK,
                transform: `translateX(${(1 - rowK) * -26}px)`,
                boxShadow: "0 8px 22px rgba(0,0,0,0.3)",
              }}
            >
              <span
                style={{
                  fontFamily: "'Poppins', sans-serif",
                  fontWeight: 600,
                  fontSize: 27,
                  color: CAFE,
                }}
              >
                {row.prize}
              </span>
              <span
                style={{
                  fontFamily: "'Poppins', sans-serif",
                  fontWeight: 800,
                  fontSize: 38,
                  color: VINO,
                  textAlign: "right",
                }}
              >
                {row.name}
              </span>
            </div>
          );
        })}

        <div
          style={{
            marginTop: 44,
            fontFamily: "'Poppins', sans-serif",
            fontWeight: 800,
            fontSize: 40,
            color: CREAM,
          }}
        >
          ¡Gracias por participar!
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: "'Poppins', sans-serif",
            fontWeight: 600,
            fontSize: 28,
            color: CORAL,
          }}
        >
          patitaspeludas.mx
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const RifaNebraskaReel: React.FC<ReelProps> = ({
  cuts,
  prizeShots,
  rampSeconds,
  musicVolume,
  editor,
}) => {
  // El encuadre de un corte depende de sus vecinos, asi que se resuelven todos
  // juntos antes de dibujar nada.
  const resolved = React.useMemo(
    () => resolveShots(cuts, prizeShots),
    [cuts, prizeShots],
  );

  const [selected, setSelected] = React.useState<number | null>(null);

  const body = bodyFrames(cuts);
  const showEditor = editor && getRemotionEnvironment().isStudio;

  return (
    <AbsoluteFill style={{backgroundColor: "#000"}}>
      <Sequence durationInFrames={INTRO_FRAMES}>
        <Intro musicVolume={musicVolume} />
      </Sequence>

      <Sequence from={INTRO_FRAMES} durationInFrames={body}>
        <AbsoluteFill>
          <Series>
            {cuts.map((cut, i) => (
              <Series.Sequence
                key={`${cut.clip}-${cut.startSeconds}-${i}`}
                durationInFrames={cutFrames(cut)}
              >
                <Reframed cut={cut} shot={resolved[i]} ramp={rampSeconds} />
              </Series.Sequence>
            ))}
          </Series>
        </AbsoluteFill>
      </Sequence>

      <Sequence from={INTRO_FRAMES + body} durationInFrames={OUTRO_FRAMES}>
        <Outro musicVolume={musicVolume} />
      </Sequence>

      {/* Fuera de los Sequence: asi ve el cuadro global del reel, no el del corte. */}
      {showEditor ? (
        <CutEditor
          cuts={cuts}
          shots={prizeShots}
          selected={selected}
          onSelect={setSelected}
        />
      ) : null}
    </AbsoluteFill>
  );
};

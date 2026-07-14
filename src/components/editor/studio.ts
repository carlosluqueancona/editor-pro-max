import {REEL_ID, type ReelProps} from "../../compositions/RifaNebraskaReel";

/**
 * @remotion/studio SOLO por import dinamico: el paquete no existe en el
 * bundle de render y un import estatico lo arrastraria. Estas funciones solo
 * se llaman desde el editor, que solo se monta dentro de Studio.
 */
const studio = () => import("@remotion/studio");

/** Escribe props en Root.tsx conservando lo que haya sin guardar en el panel. */
export const persistProps = async (patch: Partial<ReelProps>) => {
  const {saveDefaultProps} = await studio();
  await saveDefaultProps({
    compositionId: REEL_ID,
    defaultProps: ({unsavedDefaultProps}) => ({...unsavedDefaultProps, ...patch}),
  });
};

export const seekTo = async (frame: number) => {
  const {seek} = await studio();
  seek(frame);
};

/** Abre y resalta esa entrada exacta en el panel de props de Studio. */
export const showInJson = async (path: (string | number)[]) => {
  const {focusDefaultPropsPath} = await studio();
  focusDefaultPropsPath({path});
};

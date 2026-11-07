import { compositionSchema, trackSchema } from "./music.js";

/** Run the public synthetic LSTM off the UI thread. No composition leaves the browser. */
export async function composeNeural(input) {
  const config = compositionSchema.parse(input);
  const worker = new Worker("/neural-worker.js", {
    type: "module",
    name: "auralis-composer",
  });
  try {
    return await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("The local model timed out. Please try again.")),
        30000,
      );
      worker.onmessage = ({ data }) => {
        clearTimeout(deadline);
        if (!data?.ok)
          return reject(
            new Error("The local model could not compose this track."),
          );
        try {
          resolve(trackSchema.parse(data.track));
        } catch {
          reject(new Error("The local model returned an invalid composition."));
        }
      };
      worker.onerror = worker.onmessageerror = () => {
        clearTimeout(deadline);
        reject(
          new Error(
            "The local composer could not start. Please reload and try again.",
          ),
        );
      };
      try {
        worker.postMessage(config);
      } catch (error) {
        clearTimeout(deadline);
        reject(error);
      }
    });
  } finally {
    worker.terminate();
  }
}

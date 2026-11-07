import { compositionSchema } from "./music.js";

const VOCAB = 39;
const REST = 0;
const HOLD = 1;
const MAX_ASSET_BYTES = 1024 * 1024;
const ROOTS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const INTERVALS = {
  "": [0, 4, 7, 4],
  m: [0, 3, 7, 3],
  7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
};

export function seedTokens(chords) {
  const context = [];
  for (const chord of chords) {
    const match = /^([A-G])([#b]?)(maj7|m7|7|m)?$/.exec(chord);
    if (!match) throw new Error("Unsupported seed chord");
    const root =
      ROOTS[match[1]] + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
    for (const interval of INTERVALS[match[3] ?? ""]) {
      context.push(60 + root + interval - 48 + 2, HOLD);
    }
  }
  return context;
}

function readTensor(tensors, name, count) {
  const encoded = tensors?.[name];
  if (
    typeof encoded !== "string" ||
    encoded.length !== 4 * Math.ceil((count * 4) / 3)
  ) {
    throw new Error(`Invalid model tensor ${name}`);
  }
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (bytes.length !== count * 4)
    throw new Error(`Invalid tensor size ${name}`);
  const view = new DataView(bytes.buffer);
  const result = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = view.getFloat32(i * 4, true);
    if (!Number.isFinite(result[i]))
      throw new Error(`Nonfinite model tensor ${name}`);
  }
  return result;
}

/** Create recurrent state for one composition. PyTorch packs gates as i, f, g, o. */
export function createLstm(asset) {
  if (
    asset?.format !== "auralis-lstm-f32le-v1" ||
    asset.model !== "lstm-synthetic-demo" ||
    asset.tokenizer !== "melody-grid-v1" ||
    asset.vocabSize !== VOCAB
  ) {
    throw new Error("Incompatible demo checkpoint");
  }
  const {
    embedding_dim: width,
    hidden_dim: hidden,
    layers: depth,
  } = asset.architecture ?? {};
  if (
    ![width, hidden, depth].every(Number.isInteger) ||
    width < 1 ||
    width > 64 ||
    hidden < 1 ||
    hidden > 64 ||
    depth < 1 ||
    depth > 2
  )
    throw new Error("Unsupported demo architecture");
  const tensor = (name, count) => readTensor(asset.tensors, name, count);
  const embedding = tensor("embedding.weight", VOCAB * width);
  const output = tensor("output.weight", VOCAB * hidden);
  const outputBias = tensor("output.bias", VOCAB);
  const layers = [];
  for (let i = 0; i < depth; i++) {
    const inputs = i === 0 ? width : hidden;
    layers.push({
      inputs,
      inputWeights: tensor(`recurrent.weight_ih_l${i}`, 4 * hidden * inputs),
      hiddenWeights: tensor(`recurrent.weight_hh_l${i}`, 4 * hidden * hidden),
      inputBias: tensor(`recurrent.bias_ih_l${i}`, 4 * hidden),
      hiddenBias: tensor(`recurrent.bias_hh_l${i}`, 4 * hidden),
      gates: new Float32Array(4 * hidden),
      state: new Float32Array(hidden),
      cell: new Float32Array(hidden),
    });
  }
  const sigmoid = (value) => 1 / (1 + Math.exp(-value));
  const logits = new Float32Array(VOCAB);
  return {
    step(token) {
      if (!Number.isInteger(token) || token < 0 || token >= VOCAB)
        throw new Error("Invalid input token");
      let input = embedding.subarray(token * width, (token + 1) * width);
      for (const layer of layers) {
        const {
          inputs,
          inputWeights,
          hiddenWeights,
          inputBias,
          hiddenBias,
          gates,
          state,
          cell,
        } = layer;
        // Complete all matrix products before mutating this layer's previous state.
        for (let row = 0; row < gates.length; row++) {
          let value = inputBias[row] + hiddenBias[row];
          const inputOffset = row * inputs,
            hiddenOffset = row * hidden;
          for (let j = 0; j < inputs; j++)
            value += inputWeights[inputOffset + j] * input[j];
          for (let j = 0; j < hidden; j++)
            value += hiddenWeights[hiddenOffset + j] * state[j];
          gates[row] = value;
        }
        for (let j = 0; j < hidden; j++) {
          cell[j] =
            sigmoid(gates[hidden + j]) * cell[j] +
            sigmoid(gates[j]) * Math.tanh(gates[2 * hidden + j]);
          state[j] = sigmoid(gates[3 * hidden + j]) * Math.tanh(cell[j]);
        }
        input = state;
      }
      for (let row = 0; row < VOCAB; row++) {
        let sum = outputBias[row];
        for (let j = 0; j < hidden; j++)
          sum += output[row * hidden + j] * input[j];
        logits[row] = sum;
      }
      return logits;
    },
  };
}

export function sampleToken(
  logits,
  temperature,
  canHold,
  random = Math.random,
) {
  let maximum = -Infinity;
  for (let i = 0; i < VOCAB; i++) {
    if (i !== HOLD || canHold) maximum = Math.max(maximum, logits[i]);
  }
  const weights = new Float64Array(VOCAB);
  let total = 0;
  for (let i = 0; i < VOCAB; i++) {
    if (i === HOLD && !canHold) continue;
    weights[i] = Math.exp((logits[i] - maximum) / temperature);
    total += weights[i];
  }
  if (!Number.isFinite(total) || total <= 0)
    throw new Error("Invalid model probabilities");
  const draw = random() * total;
  let cumulative = 0,
    last = REST;
  for (let i = 0; i < VOCAB; i++) {
    if (weights[i] === 0) continue;
    last = i;
    cumulative += weights[i];
    if (draw < cumulative) return i;
  }
  return last;
}

export function composeFromWeights(input, asset, random = Math.random) {
  const config = compositionSchema.parse(input);
  const model = createLstm(asset);
  let logits;
  for (const token of seedTokens(config.seed_chords))
    logits = model.step(token);
  const notes = [],
    stepSeconds = 15 / config.tempo;
  let active = null;
  for (let i = 0; i < config.bars * 16; i++) {
    const token = sampleToken(
      logits,
      config.temperature,
      active !== null,
      random,
    );
    if (token === HOLD) active.duration += stepSeconds;
    else if (token === REST) active = null;
    else {
      active = {
        pitch: token + 46,
        start: i * stepSeconds,
        duration: stepSeconds,
        velocity: i % 4 ? 82 : 94,
      };
      notes.push(active);
    }
    logits = model.step(token);
  }
  return {
    ...config,
    id: crypto.randomUUID(),
    title: "Untitled composition",
    created_at: new Date().toISOString(),
    model: "lstm-synthetic-demo",
    duration: (config.bars * 4 * 60) / config.tempo,
    notes,
  };
}

async function fetchWeights() {
  const response = await fetch("/demo-weights.json", {
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error("Demo weights unavailable");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ASSET_BYTES) {
      await reader.cancel();
      throw new Error("Demo weights exceed size limit");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return JSON.parse(chunks.join(""));
}

if (
  typeof WorkerGlobalScope !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  self.onmessage = async ({ data }) => {
    try {
      const config = compositionSchema.parse(data);
      const track = composeFromWeights(config, await fetchWeights());
      self.postMessage({ ok: true, track });
    } catch {
      self.postMessage({ ok: false });
    } finally {
      self.close();
    }
  };
}

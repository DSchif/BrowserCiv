export interface MLPWeights {
  layers: Array<{ W: number[]; b: number[]; inSize: number; outSize: number }>;
}

export interface LayerCache {
  input: number[];
  z: number[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randn(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function he(fanIn: number): number {
  return randn() * Math.sqrt(2 / fanIn);
}

function mv(W: number[], rows: number, cols: number, v: number[]): number[] {
  const out = new Array<number>(rows).fill(0);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      out[i]! += W[i * cols + j]! * v[j]!;
    }
  }
  return out;
}

function mTv(W: number[], rows: number, cols: number, v: number[]): number[] {
  const out = new Array<number>(cols).fill(0);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      out[j]! += W[i * cols + j]! * v[i]!;
    }
  }
  return out;
}

// ── MLP ───────────────────────────────────────────────────────────────────────

interface Layer {
  W: number[];
  b: number[];
  inSize: number;
  outSize: number;
}

export class MLP {
  private layers: Layer[];

  constructor(inputSize: number, hidden: number[]) {
    const sizes = [inputSize, ...hidden, 1];
    this.layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const inSize = sizes[l]!;
      const outSize = sizes[l + 1]!;
      const W = Array.from({ length: inSize * outSize }, () => he(inSize));
      const b = new Array<number>(outSize).fill(0);
      this.layers.push({ W, b, inSize, outSize });
    }
  }

  forward(x: number[]): { q: number; cache: LayerCache[] } {
    const cache: LayerCache[] = [];
    let h = x;
    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l]!;
      const z = mv(layer.W, layer.outSize, layer.inSize, h).map((v, i) => v + layer.b[i]!);
      cache.push({ input: h, z });
      const isLast = l === this.layers.length - 1;
      h = isLast ? z : z.map((v) => Math.max(0, v));
    }
    return { q: h[0]!, cache };
  }

  tdUpdate(cache: LayerCache[], error: number, lr: number): void {
    let dh = [1.0];
    for (let l = this.layers.length - 1; l >= 0; l--) {
      const layer = this.layers[l]!;
      const { input, z } = cache[l]!;
      const isLast = l === this.layers.length - 1;
      const dz = isLast
        ? dh
        : dh.map((d, i) => d * (z[i]! > 0 ? 1 : 0));

      const dInput = mTv(layer.W, layer.outSize, layer.inSize, dz);

      for (let i = 0; i < layer.outSize; i++) {
        for (let j = 0; j < layer.inSize; j++) {
          layer.W[i * layer.inSize + j]! += lr * error * dz[i]! * input[j]!;
        }
        layer.b[i]! += lr * error * dz[i]!;
      }

      dh = dInput;
    }
  }

  toJSON(): MLPWeights {
    return {
      layers: this.layers.map((l) => ({
        W: l.W,
        b: l.b,
        inSize: l.inSize,
        outSize: l.outSize,
      })),
    };
  }

  static fromJSON(data: MLPWeights): MLP {
    const inSize = data.layers[0]!.inSize;
    const hidden = data.layers.slice(0, -1).map((l) => l.outSize);
    const net = new MLP(inSize, hidden);
    for (let l = 0; l < net.layers.length; l++) {
      net.layers[l]!.W = data.layers[l]!.W;
      net.layers[l]!.b = data.layers[l]!.b;
    }
    return net;
  }
}

/**
 * Tiny feed-forward neural network for Q-value approximation.
 *
 * Architecture: IN → H1 → H2 → 1  (ReLU hidden activations, linear output)
 *
 * Uses explicit backprop so there are no external ML dependencies.
 * Weight updates follow the TD-learning sign convention:
 *   W += lr * td_error * ∂Q/∂W
 * which is equivalent to gradient descent on ½(target - Q)².
 */

const IN = 15;
const H1 = 64;
const H2 = 32;

function randn(): number {
  // Box-Muller transform → standard normal
  const u = Math.random() || 1e-10;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function he(fanIn: number): number {
  return randn() * Math.sqrt(2 / fanIn);
}

// A (m×n) @ x (n) → y (m)
function mv(A: number[], x: number[], m: number, n: number): number[] {
  const y = new Array<number>(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i * n + j]! * x[j]!;
    y[i] = s;
  }
  return y;
}

// A^T (n×m) @ x (m) → y (n)   (A is stored as m×n)
function mTv(A: number[], x: number[], m: number, n: number): number[] {
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) y[j]! += A[i * n + j]! * x[i]!;
  }
  return y;
}

export interface MLPCache {
  x:  number[];  // input
  z1: number[];  // pre-ReLU layer 1
  h1: number[];  // post-ReLU layer 1
  z2: number[];  // pre-ReLU layer 2
  h2: number[];  // post-ReLU layer 2
}

export interface MLPWeights {
  W1: number[]; b1: number[];
  W2: number[]; b2: number[];
  W3: number[]; b3: number[];
}

export class MLP {
  W1: number[];  // H1 × IN
  b1: number[];  // H1
  W2: number[];  // H2 × H1
  b2: number[];  // H2
  W3: number[];  // 1  × H2
  b3: number[];  // 1

  constructor() {
    this.W1 = Array.from({ length: H1 * IN }, () => he(IN));
    this.b1 = new Array<number>(H1).fill(0);
    this.W2 = Array.from({ length: H2 * H1 }, () => he(H1));
    this.b2 = new Array<number>(H2).fill(0);
    this.W3 = Array.from({ length: H2 }, () => he(H2));
    this.b3 = [0];
  }

  forward(x: number[]): { q: number; cache: MLPCache } {
    const z1 = mv(this.W1, x, H1, IN).map((v, i) => v + this.b1[i]!);
    const h1 = z1.map((v) => (v > 0 ? v : 0));
    const z2 = mv(this.W2, h1, H2, H1).map((v, i) => v + this.b2[i]!);
    const h2 = z2.map((v) => (v > 0 ? v : 0));
    const q  = this.W3.reduce((s, w, j) => s + w * h2[j]!, 0) + this.b3[0]!;
    return { q, cache: { x, z1, h1, z2, h2 } };
  }

  /**
   * Online TD update.  error = target_Q - current_Q.
   * Positive error → push weights so Q increases toward target.
   *
   * All upstream gradients are captured from `cache` before any weight
   * changes, so the update is mathematically correct.
   */
  tdUpdate(cache: MLPCache, error: number, lr: number): void {
    // ── Compute gradients (chain rule, no weight mutations yet) ──────────────

    // Layer 3: Q = W3 · h2 + b3
    // ∂Q/∂h2[j] = W3[j]
    // ∂Q/∂W3[j] = h2[j]
    const dh2 = this.W3.slice();  // length H2

    // Layer 2: h2 = relu(z2), z2 = W2 @ h1 + b2
    // ∂Q/∂z2[i] = ∂Q/∂h2[i] · relu'(z2[i])
    const dz2 = dh2.map((d, i) => d * (cache.z2[i]! > 0 ? 1 : 0));  // H2
    // ∂Q/∂h1 = W2^T @ dz2
    const dh1 = mTv(this.W2, dz2, H2, H1);  // H1

    // Layer 1: h1 = relu(z1), z1 = W1 @ x + b1
    // ∂Q/∂z1[i] = ∂Q/∂h1[i] · relu'(z1[i])
    const dz1 = dh1.map((d, i) => d * (cache.z1[i]! > 0 ? 1 : 0));  // H1

    // ── Apply updates: W += lr * error * ∂Q/∂W ──────────────────────────────

    // Layer 3
    for (let j = 0; j < H2; j++) this.W3[j]! += lr * error * cache.h2[j]!;
    this.b3[0]! += lr * error;

    // Layer 2
    for (let i = 0; i < H2; i++) {
      for (let j = 0; j < H1; j++) this.W2[i * H1 + j]! += lr * error * dz2[i]! * cache.h1[j]!;
      this.b2[i]! += lr * error * dz2[i]!;
    }

    // Layer 1
    for (let i = 0; i < H1; i++) {
      for (let j = 0; j < IN; j++) this.W1[i * IN + j]! += lr * error * dz1[i]! * cache.x[j]!;
      this.b1[i]! += lr * error * dz1[i]!;
    }
  }

  toJSON(): MLPWeights {
    return {
      W1: this.W1, b1: this.b1,
      W2: this.W2, b2: this.b2,
      W3: this.W3, b3: this.b3,
    };
  }

  static fromJSON(data: MLPWeights): MLP {
    const net = new MLP();
    net.W1 = data.W1; net.b1 = data.b1;
    net.W2 = data.W2; net.b2 = data.b2;
    net.W3 = data.W3; net.b3 = data.b3;
    return net;
  }
}

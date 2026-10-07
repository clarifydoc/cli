import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const SRC = `
__device__ __forceinline__ float add(float x, float y) {
    return x + y;
}

__global__ void vectorAdd(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = add(a[i], b[i]);
}

template <typename T>
__global__ void scale(T* data, T factor, int n) {
    data[blockIdx.x] *= factor;
}

void launch(float* a, float* b, float* c, int n) {
    vectorAdd<<<(n + 255) / 256, 256>>>(a, b, c, n);
    scale<float><<<dim3(n / 256), dim3(256), 0, stream>>>(c, 2.0f, n);
    cudaDeviceSynchronize();
}
`;

describe("CUDA (.cu through the C++ plugin)", () => {
  const analysis = extractWithRegex(SRC, "src/kernels.cu", "cpp");
  const fn = (name: string) => analysis.functions.find((f) => f.name === name);

  it("reads kernel and device functions as functions", () => {
    expect(analysis.functions.map((f) => f.name)).toEqual(["add", "vectorAdd", "scale", "launch"]);
    expect(fn("vectorAdd")?.calls.map((c) => c.name)).toEqual(["add"]);
  });

  it("reads a <<<grid, block>>> launch as a call of the kernel", () => {
    expect(fn("launch")?.calls.map((c) => c.name)).toEqual(["vectorAdd", "scale", "dim3", "cudaDeviceSynchronize"]);
  });
});

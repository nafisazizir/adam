declare module "heic-decode" {
  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  function decode(input: {
    buffer: Buffer | Uint8Array | ArrayBuffer;
  }): Promise<DecodedImage>;
  export default decode;
}

declare module "heic-convert" {
  function convert(options: {
    buffer: Buffer | ArrayBuffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }): Promise<ArrayBuffer>;

  export = convert;
}

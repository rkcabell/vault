/**
 * Type declarations for the heic-convert package, which ships none of its own.
 */
declare module "heic-convert" {
  function convert(options: {
    buffer: Buffer | ArrayBuffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }): Promise<ArrayBuffer>;

  export = convert;
}

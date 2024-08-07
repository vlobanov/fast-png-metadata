import { DecoderInputType, PngDecoderOptions, DecodedPng, ImageData, PngEncoderOptions } from './types';
export { hasPngSignature } from './helpers/signature';
export * from './types';
declare function decodePng(data: DecoderInputType, options?: PngDecoderOptions): DecodedPng;
declare function encodePng(png: ImageData, options?: PngEncoderOptions): Uint8Array;
export { decodePng as decode, encodePng as encode };

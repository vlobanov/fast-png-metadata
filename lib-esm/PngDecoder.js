import { IOBuffer } from 'iobuffer';
import { inflate, Inflate as Inflator } from 'pako';
import { checkCrc } from './helpers/crc';
import { decodeInterlaceNull } from './helpers/decodeInterlaceNull';
import { checkSignature } from './helpers/signature';
import { decodetEXt, readKeyword, textChunkName } from './helpers/text';
import { ColorType, CompressionMethod, FilterMethod, InterlaceMethod, } from './internalTypes';
export default class PngDecoder extends IOBuffer {
    constructor(data, options = {}) {
        super(data);
        const { checkCrc = false, onlyMetadata = false } = options;
        this._checkCrc = checkCrc;
        this._onlyMetadata = onlyMetadata;
        this._inflator = new Inflator();
        this._png = {
            width: -1,
            height: -1,
            channels: -1,
            data: new Uint8Array(0),
            depth: 1,
            text: {},
        };
        this._end = false;
        this._hasPalette = false;
        this._palette = [];
        this._hasTransparency = false;
        this._transparency = new Uint16Array(0);
        this._compressionMethod = CompressionMethod.UNKNOWN;
        this._filterMethod = FilterMethod.UNKNOWN;
        this._interlaceMethod = InterlaceMethod.UNKNOWN;
        this._colorType = ColorType.UNKNOWN;
        // PNG is always big endian
        // https://www.w3.org/TR/PNG/#7Integers-and-byte-order
        this.setBigEndian();
    }
    decode() {
        checkSignature(this);
        while (!this._end) {
            this.decodeChunk();
        }
        if (!this._onlyMetadata) {
            this.decodeImage();
        }
        return this._png;
    }
    // https://www.w3.org/TR/PNG/#5Chunk-layout
    decodeChunk() {
        const length = this.readUint32();
        const type = this.readChars(4);
        const offset = this.offset;
        switch (type) {
            // 11.2 Critical chunks
            case 'IHDR': // 11.2.2 IHDR Image header
                this.decodeIHDR();
                if (this._onlyMetadata) {
                    this._end = true;
                }
                break;
            case 'PLTE': // 11.2.3 PLTE Palette
                this.decodePLTE(length);
                break;
            case 'IDAT': // 11.2.4 IDAT Image data
                this.decodeIDAT(length);
                break;
            case 'IEND': // 11.2.5 IEND Image trailer
                this._end = true;
                break;
            // 11.3 Ancillary chunks
            case 'tRNS': // 11.3.2.1 tRNS Transparency
                this.decodetRNS(length);
                break;
            case 'iCCP': // 11.3.3.3 iCCP Embedded ICC profile
                this.decodeiCCP(length);
                break;
            case textChunkName: // 11.3.4.3 tEXt Textual data
                decodetEXt(this._png.text, this, length);
                break;
            case 'pHYs': // 11.3.5.3 pHYs Physical pixel dimensions
                this.decodepHYs();
                break;
            default:
                this.skip(length);
                break;
        }
        if (this.offset - offset !== length) {
            throw new Error(`Length mismatch while decoding chunk ${type}`);
        }
        if (this._checkCrc) {
            checkCrc(this, length + 4, type);
        }
        else {
            this.skip(4);
        }
    }
    // https://www.w3.org/TR/PNG/#11IHDR
    decodeIHDR() {
        const image = this._png;
        image.width = this.readUint32();
        image.height = this.readUint32();
        image.depth = checkBitDepth(this.readUint8());
        const colorType = this.readUint8();
        this._colorType = colorType;
        let channels;
        switch (colorType) {
            case ColorType.GREYSCALE:
                channels = 1;
                break;
            case ColorType.TRUECOLOUR:
                channels = 3;
                break;
            case ColorType.INDEXED_COLOUR:
                channels = 1;
                break;
            case ColorType.GREYSCALE_ALPHA:
                channels = 2;
                break;
            case ColorType.TRUECOLOUR_ALPHA:
                channels = 4;
                break;
            default:
                throw new Error(`Unknown color type: ${colorType}`);
        }
        this._png.channels = channels;
        this._compressionMethod = this.readUint8();
        if (this._compressionMethod !== CompressionMethod.DEFLATE) {
            throw new Error(`Unsupported compression method: ${this._compressionMethod}`);
        }
        this._filterMethod = this.readUint8();
        this._interlaceMethod = this.readUint8();
    }
    // https://www.w3.org/TR/PNG/#11PLTE
    decodePLTE(length) {
        if (length % 3 !== 0) {
            throw new RangeError(`PLTE field length must be a multiple of 3. Got ${length}`);
        }
        const l = length / 3;
        this._hasPalette = true;
        const palette = [];
        this._palette = palette;
        for (let i = 0; i < l; i++) {
            palette.push([this.readUint8(), this.readUint8(), this.readUint8()]);
        }
    }
    // https://www.w3.org/TR/PNG/#11IDAT
    decodeIDAT(length) {
        this._inflator.push(new Uint8Array(this.buffer, this.offset + this.byteOffset, length));
        this.skip(length);
    }
    // https://www.w3.org/TR/PNG/#11tRNS
    decodetRNS(length) {
        switch (this._colorType) {
            case ColorType.GREYSCALE:
            case ColorType.TRUECOLOUR: {
                if (length % 2 !== 0) {
                    throw new RangeError(`tRNS chunk length must be a multiple of 2. Got ${length}`);
                }
                if (length / 2 > this._png.width * this._png.height) {
                    throw new Error(`tRNS chunk contains more alpha values than there are pixels (${length / 2} vs ${this._png.width * this._png.height})`);
                }
                this._hasTransparency = true;
                this._transparency = new Uint16Array(length / 2);
                for (let i = 0; i < length / 2; i++) {
                    this._transparency[i] = this.readUint16();
                }
                break;
            }
            case ColorType.INDEXED_COLOUR: {
                if (length > this._palette.length) {
                    throw new Error(`tRNS chunk contains more alpha values than there are palette colors (${length} vs ${this._palette.length})`);
                }
                let i = 0;
                for (; i < length; i++) {
                    const alpha = this.readByte();
                    this._palette[i].push(alpha);
                }
                for (; i < this._palette.length; i++) {
                    this._palette[i].push(255);
                }
                break;
            }
            default: {
                throw new Error(`tRNS chunk is not supported for color type ${this._colorType}`);
            }
        }
    }
    // https://www.w3.org/TR/PNG/#11iCCP
    decodeiCCP(length) {
        const name = readKeyword(this);
        const compressionMethod = this.readUint8();
        if (compressionMethod !== CompressionMethod.DEFLATE) {
            throw new Error(`Unsupported iCCP compression method: ${compressionMethod}`);
        }
        const compressedProfile = this.readBytes(length - name.length - 2);
        this._png.iccEmbeddedProfile = {
            name,
            profile: inflate(compressedProfile),
        };
    }
    // https://www.w3.org/TR/PNG/#11pHYs
    decodepHYs() {
        const ppuX = this.readUint32();
        const ppuY = this.readUint32();
        const unitSpecifier = this.readByte();
        this._png.resolution = { x: ppuX, y: ppuY, unit: unitSpecifier };
    }
    decodeImage() {
        if (this._inflator.err) {
            throw new Error(`Error while decompressing the data: ${this._inflator.err}`);
        }
        const data = this._inflator.result;
        if (this._filterMethod !== FilterMethod.ADAPTIVE) {
            throw new Error(`Filter method ${this._filterMethod} not supported`);
        }
        if (this._interlaceMethod === InterlaceMethod.NO_INTERLACE) {
            this._png.data = decodeInterlaceNull({
                data: data,
                width: this._png.width,
                height: this._png.height,
                channels: this._png.channels,
                depth: this._png.depth,
            });
        }
        else {
            throw new Error(`Interlace method ${this._interlaceMethod} not supported`);
        }
        if (this._hasPalette) {
            this._png.palette = this._palette;
        }
        if (this._hasTransparency) {
            this._png.transparency = this._transparency;
        }
    }
}
function checkBitDepth(value) {
    if (value !== 1 &&
        value !== 2 &&
        value !== 4 &&
        value !== 8 &&
        value !== 16) {
        throw new Error(`invalid bit depth: ${value}`);
    }
    return value;
}
//# sourceMappingURL=PngDecoder.js.map
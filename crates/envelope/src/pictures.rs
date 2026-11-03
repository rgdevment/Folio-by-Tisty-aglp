use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::imageops::FilterType as Resize;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgb, RgbImage};

use crate::envelope::{Kind, Refused};
use crate::limits::Limits;

/// A page is read a few hundred pixels wide; anything past this is only weight.
const SIDE_AT_MOST: u32 = 1600;
const QUALITY: u8 = 82;
/// Each try keeps three quarters of the side, so six reach about a sixth of where it began.
const TRIES: usize = 6;
/// Far past any photo, short of what a crafted header could ask a machine to hold.
const DECODED_AT_MOST: u64 = 256 * 1024 * 1024;

/// Decoded and written again, so nothing travels but the pixels: no location, no comments, no hidden file.
pub fn recompressed(bytes: &[u8], limits: &Limits) -> Result<(Kind, Vec<u8>), Refused> {
    let kind = Kind::of_picture(bytes).ok_or(Refused::NotAPicture)?;
    if !limits.takes(Kind::Png) && !limits.takes(Kind::Jpeg) {
        return Err(Refused::KindRefused);
    }
    let (decoded, turned) = decoded(bytes, kind)?;
    // A photo that needs no turning nor shrinking travels as it was written, since writing it again often makes it heavier.
    let mut kept = (kind == Kind::Jpeg
        && !turned
        && limits.takes(Kind::Jpeg)
        && decoded.width() <= SIDE_AT_MOST
        && decoded.height() <= SIDE_AT_MOST)
        .then(|| stripped(bytes, (decoded.width(), decoded.height())))
        .flatten()
        .filter(|one| one.len() as u64 <= limits.picture);
    let mut picture = fitted(decoded, SIDE_AT_MOST);
    for _ in 0..TRIES {
        let made = smallest_of(&picture, kind, limits)?;
        let chosen = match (kept.take(), made) {
            (Some(kept), Some(made)) if kept.len() <= made.1.len() => Some((Kind::Jpeg, kept)),
            (Some(kept), None) => Some((Kind::Jpeg, kept)),
            (_, made) => made,
        };
        if let Some(chosen) = chosen {
            return Ok(chosen);
        }
        let (wide, tall) = (picture.width(), picture.height());
        picture = picture.resize(
            (wide * 3 / 4).max(1),
            (tall * 3 / 4).max(1),
            Resize::Lanczos3,
        );
    }
    Err(Refused::PictureTooBig)
}

/// The picture as it stands, and whether its tag turned it.
fn decoded(bytes: &[u8], kind: Kind) -> Result<(DynamicImage, bool), Refused> {
    let format = match kind {
        Kind::Png => ImageFormat::Png,
        Kind::Jpeg => ImageFormat::Jpeg,
        Kind::Webp => ImageFormat::WebP,
        Kind::Gif => ImageFormat::Gif,
        Kind::Text | Kind::Signature | Kind::Cited | Kind::Html | Kind::Config => {
            return Err(Refused::NotAPicture);
        }
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut held = image::Limits::default();
    held.max_alloc = Some(DECODED_AT_MOST);
    reader.limits(held);
    let mut decoder = reader.into_decoder().map_err(|_| Refused::NotAPicture)?;
    // A photo stands as it was taken, since the tag that turned it is not written again.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut picture = DynamicImage::from_decoder(decoder).map_err(|_| Refused::NotAPicture)?;
    picture.apply_orientation(orientation);
    Ok((plain(picture), orientation != Orientation::NoTransforms))
}

/// The JPEG as written, less every segment that says something besides its pixels and anything past its end;
/// none when it is coded in a way a browser does not draw.
fn stripped(bytes: &[u8], size: (u32, u32)) -> Option<Vec<u8>> {
    let mut out = bytes.get(..2).filter(|soi| *soi == [0xFF, 0xD8])?.to_vec();
    let mut at = 2;
    let mut drawable = false;
    loop {
        if *bytes.get(at)? != 0xFF {
            return None;
        }
        let mut named = at + 1;
        while *bytes.get(named)? == 0xFF {
            named += 1;
        }
        let marker = bytes[named];
        let start = named + 1;
        match marker {
            0xD9 => {
                out.extend_from_slice(&[0xFF, 0xD9]);
                break;
            }
            0x01 | 0xD0..=0xD7 => {
                out.extend_from_slice(&[0xFF, marker]);
                at = start;
                continue;
            }
            _ => {}
        }
        let len = usize::from(u16::from_be_bytes([
            *bytes.get(start)?,
            *bytes.get(start + 1)?,
        ]));
        let end = start.checked_add(len).filter(|_| len >= 2)?;
        let segment = bytes.get(start..end)?;
        match marker {
            // Baseline, extended and progressive Huffman are what every browser draws.
            0xC0..=0xC2 => drawable = true,
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return None,
            _ => {}
        }
        // A colour profile and Adobe's APP14 say how to read the pixels; the other APPn and comments say where, when, by whom, or hold a thumbnail.
        let profile = marker == 0xE2 && segment.get(2..14) == Some(b"ICC_PROFILE\0");
        if profile || !matches!(marker, 0xE0..=0xED | 0xEF | 0xFE) {
            out.extend_from_slice(&[0xFF, marker]);
            out.extend_from_slice(segment);
        }
        at = end;
        if marker == 0xDA {
            let scan = at;
            // The scan runs until a marker that is neither a stuffed byte, a restart nor a fill byte.
            while !(bytes.get(at)? == &0xFF
                && !matches!(*bytes.get(at + 1)?, 0x00 | 0xD0..=0xD7 | 0xFF))
            {
                at += 1;
            }
            out.extend_from_slice(&bytes[scan..at]);
        }
    }
    let read = ImageReader::with_format(Cursor::new(&out), ImageFormat::Jpeg).into_dimensions();
    (drawable && read.ok()? == size).then_some(out)
}

/// Eight bits a channel is all a page shows; an alpha channel nothing shows through is dropped, so the picture may fit as a JPEG.
fn plain(picture: DynamicImage) -> DynamicImage {
    if picture.color().has_alpha() {
        let rgba = picture.to_rgba8();
        if rgba.pixels().any(|one| one[3] < u8::MAX) {
            return DynamicImage::ImageRgba8(rgba);
        }
    }
    DynamicImage::ImageRgb8(picture.to_rgb8())
}

fn fitted(picture: DynamicImage, side: u32) -> DynamicImage {
    if picture.width() <= side && picture.height() <= side {
        picture
    } else {
        picture.resize(side, side, Resize::Lanczos3)
    }
}

/// A photo stays a photo and the rest a PNG; an opaque PNG may become a JPEG to fit, and a server's one kind wins.
fn smallest_of(
    picture: &DynamicImage,
    kind: Kind,
    limits: &Limits,
) -> Result<Option<(Kind, Vec<u8>)>, Refused> {
    let fits = |bytes: &[u8]| bytes.len() as u64 <= limits.picture;
    let (png, jpeg) = (limits.takes(Kind::Png), limits.takes(Kind::Jpeg));
    if png && (kind != Kind::Jpeg || !jpeg) {
        let written = as_png(picture, CompressionType::Default)?;
        if fits(&written) {
            // The slower compression is paid once, on the side that fits, never on each side tried before it.
            let best = as_png(picture, CompressionType::Best)?;
            let smaller = std::cmp::min_by_key(best, written, Vec::len);
            return Ok(Some((Kind::Png, smaller)));
        }
        if picture.color().has_alpha() {
            return Ok(None);
        }
    }
    if !jpeg {
        return Ok(None);
    }
    let written = as_jpeg(picture)?;
    Ok(fits(&written).then_some((Kind::Jpeg, written)))
}

fn as_png(picture: &DynamicImage, compression: CompressionType) -> Result<Vec<u8>, Refused> {
    let mut out = Vec::new();
    picture
        .write_with_encoder(PngEncoder::new_with_quality(
            &mut out,
            compression,
            FilterType::Adaptive,
        ))
        .map_err(|_| Refused::NotAPicture)?;
    Ok(out)
}

fn as_jpeg(picture: &DynamicImage) -> Result<Vec<u8>, Refused> {
    let mut out = Vec::new();
    DynamicImage::ImageRgb8(on_white(picture))
        .write_with_encoder(JpegEncoder::new_with_quality(&mut out, QUALITY))
        .map_err(|_| Refused::NotAPicture)?;
    Ok(out)
}

/// The sheet under a picture is white, so what showed through lands on white, not on the color the hidden pixels kept.
fn on_white(picture: &DynamicImage) -> RgbImage {
    if !picture.color().has_alpha() {
        return picture.to_rgb8();
    }
    let rgba = picture.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let over = |c: u8| {
            let (c, a) = (u16::from(c), u16::from(a));
            ((c * a + 255 * (255 - a) + 127) / 255) as u8
        };
        Rgb([over(r), over(g), over(b)])
    })
}

#[cfg(test)]
#[path = "pictures_test.rs"]
mod tests;

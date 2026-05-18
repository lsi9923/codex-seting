#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def resize_to_width(image: Image.Image, target_width: int) -> Image.Image:
    if image.width == target_width:
        return image
    ratio = target_width / image.width
    target_height = max(1, int(image.height * ratio))
    return image.resize((target_width, target_height), Image.LANCZOS)


def merge_images_vertical(
    image_paths: list[Path],
    output_path: Path,
    target_width: int = 860,
    gap: int = 0,
) -> Path:
    opened_images: list[Image.Image] = []
    resized_images: list[Image.Image] = []

    try:
        for image_path in image_paths:
            opened = Image.open(image_path).convert("RGB")
            opened_images.append(opened)
            resized_images.append(resize_to_width(opened, target_width))

        total_height = sum(image.height for image in resized_images)
        total_height += gap * max(0, len(resized_images) - 1)

        merged = Image.new("RGB", (target_width, total_height), (255, 255, 255))

        y_offset = 0
        for image in resized_images:
            merged.paste(image, (0, y_offset))
            y_offset += image.height + gap

        output_path.parent.mkdir(parents=True, exist_ok=True)
        merged.save(output_path, "PNG")
        merged.close()
        return output_path
    finally:
        for image in resized_images:
            image.close()
        for image in opened_images:
            image.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge section images into one vertical product detail page PNG.",
    )
    parser.add_argument(
        "--images",
        nargs="+",
        required=True,
        help="Input image files in the desired order.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output PNG path.",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=860,
        help="Target width in pixels. Default: 860",
    )
    parser.add_argument(
        "--gap",
        type=int,
        default=0,
        help="Gap between images in pixels. Default: 0",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    image_paths = [Path(image).expanduser().resolve() for image in args.images]
    output_path = Path(args.output).expanduser().resolve()

    if args.width <= 0:
        raise SystemExit("--width must be greater than 0")
    if args.gap < 0:
        raise SystemExit("--gap must be 0 or greater")
    if not image_paths:
        raise SystemExit("At least one input image is required")

    missing = [str(path) for path in image_paths if not path.exists()]
    if missing:
        raise SystemExit(f"Input image not found: {missing[0]}")

    saved_path = merge_images_vertical(
        image_paths=image_paths,
        output_path=output_path,
        target_width=args.width,
        gap=args.gap,
    )
    print(saved_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

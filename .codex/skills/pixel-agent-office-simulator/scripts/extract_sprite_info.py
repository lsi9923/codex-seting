#!/usr/bin/env python3
"""
extract_sprite_info.py — connect-ai 저장소에서 스프라이트/에이전트 정보 추출

사용법:
  python extract_sprite_info.py <repo_path>

출력:
  - 에이전트 목록 (id, name, color, sprite 경로)
  - 스프라이트 시트 크기 확인
  - 책상 위치 좌표
"""

import sys
import os
import json

def extract_from_extension(repo_path: str) -> dict:
    ext_path = os.path.join(repo_path, 'src', 'extension.ts')
    if not os.path.exists(ext_path):
        print(f"ERROR: {ext_path} not found")
        sys.exit(1)

    with open(ext_path, 'rb') as f:
        content = f.read().decode('utf-8', errors='replace')

    lines = content.split('\n')
    result = {
        'agents': [],
        'sprite_config': {},
        'desk_positions': {},
        'animation_config': {},
    }

    # 스프라이트 애니메이션 설정 추출
    for i, line in enumerate(lines):
        if 'TILE = 48' in line:
            result['sprite_config']['TILE'] = 48
        if 'CHAR_HEIGHT = TILE * 2' in line or 'CHAR_HEIGHT = 96' in line:
            result['sprite_config']['CHAR_HEIGHT'] = 96
        if 'frameIndex' in line and '% 6' in line:
            result['sprite_config']['frames_per_dir'] = 6
        if 'colOffset = 0' in line and 'down' in lines[max(0,i-2):i+2]:
            result['sprite_config']['dirs'] = {'down': 0, 'left': 6, 'right': 12, 'up': 18}

    # HOME_POS 추출
    in_home_pos = False
    for line in lines:
        if 'let HOME_POS' in line or 'HOME_POS = {' in line:
            in_home_pos = True
        if in_home_pos and '}' in line and 'HOME_POS' not in line:
            in_home_pos = False
        if in_home_pos and ':' in line and '{' in line and 'x:' in line:
            try:
                parts = line.strip().split(':')
                agent_id = parts[0].strip().strip("'\"")
                coords = line.split('{')[1].split('}')[0]
                x = float([p for p in coords.split(',') if 'x' in p][0].split(':')[1])
                y = float([p for p in coords.split(',') if 'y' in p][0].split(':')[1])
                result['desk_positions'][agent_id] = {'x': x, 'y': y}
            except Exception:
                pass

    return result


def check_sprites(repo_path: str) -> list:
    chars_dir = os.path.join(repo_path, 'assets', 'pixel', 'characters')
    if not os.path.exists(chars_dir):
        return []

    sprites = []
    try:
        from PIL import Image
        for f in sorted(os.listdir(chars_dir)):
            if f.endswith('.png'):
                img = Image.open(os.path.join(chars_dir, f))
                sprites.append({
                    'id': f.replace('.png', ''),
                    'path': os.path.join(chars_dir, f),
                    'size': img.size,
                    'valid': img.size == (2688, 1968),
                })
    except ImportError:
        for f in sorted(os.listdir(chars_dir)):
            if f.endswith('.png'):
                sprites.append({'id': f.replace('.png', ''), 'path': os.path.join(chars_dir, f)})

    return sprites


def main():
    repo_path = sys.argv[1] if len(sys.argv) > 1 else '.'
    print(f"Analyzing: {repo_path}\n")

    info = extract_from_extension(repo_path)
    sprites = check_sprites(repo_path)

    print("=== Sprite Config ===")
    print(json.dumps(info['sprite_config'], indent=2))

    print("\n=== Desk Positions ===")
    print(json.dumps(info['desk_positions'], indent=2))

    print("\n=== Available Sprites ===")
    for s in sprites:
        valid = "✓" if s.get('valid', True) else "✗"
        size = str(s.get('size', 'unknown'))
        print(f"  {valid} {s['id']}: {size}")

    print(f"\nTotal sprites: {len(sprites)}")
    print("\nRecommended DESK_POSITIONS for webdev project:")
    print("(Adjust x/y to match your office background image)")
    for agent_id, pos in info['desk_positions'].items():
        print(f"  {agent_id}: {{ x: {pos['x']}, y: {pos['y']} }},")


if __name__ == '__main__':
    main()

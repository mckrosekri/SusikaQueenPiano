from pathlib import Path
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'output' / 'brand' / 'susika'
PUBLIC = ROOT / 'public' / 'brand'
OUT.mkdir(parents=True, exist_ok=True)
S = 4
ROSE = '#A43870'
PLUM = '#593157'
BLUSH = '#FAD4E7'
bars = [(128, 252, 48, 140, 24), (196, 216, 48, 176, 24), (264, 244, 48, 148, 24), (332, 208, 48, 184, 24)]
crown = [(154, 184), (144, 118), (210, 147), (256, 80), (302, 147), (368, 118), (358, 184)]

def artwork(mask=False, background=None):
    image = Image.new('RGBA', (512*S, 512*S), background or (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for x, y, w, h, r in bars:
        draw.rounded_rectangle((x*S,y*S,(x+w)*S,(y+h)*S), radius=r*S, fill='#141414' if mask else ROSE)
    draw.polygon([(x*S,y*S) for x,y in crown], fill='#141414' if mask else PLUM)
    draw.rounded_rectangle((155*S,177*S,357*S,194*S),radius=8*S,fill='#141414' if mask else PLUM)
    return image.resize((512,512),Image.Resampling.LANCZOS)

def svg(mask=False):
    keys='\n'.join(f'    <rect id="key-{i+1}" x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}"/>' for i,(x,y,w,h,r) in enumerate(bars))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="SusikaQueenPiano crowned piano mark">
  <g id="piano" fill="{'#141414' if mask else ROSE}">
{keys}
  </g>
  <g id="crown" fill="{'#141414' if mask else PLUM}">
    <path id="crown-points" d="M154 184 L144 118 L210 147 L256 80 L302 147 L368 118 L358 184 Z"/>
    <rect id="crown-band" x="155" y="177" width="202" height="17" rx="8"/>
  </g>
</svg>
'''

artwork().save(OUT/'source.png')
artwork(mask=True, background='white').convert('RGB').save(OUT/'source_qa_mask.png')
artwork().save(PUBLIC/'susika-foreground.png')
artwork(background=BLUSH).save(PUBLIC/'susika-icon-512.png')
(PUBLIC/'mark.svg').write_text(svg(),encoding='utf-8')
(PUBLIC/'favicon.svg').write_text(svg(),encoding='utf-8')
(OUT/'qa-mark.svg').write_text(svg(mask=True),encoding='utf-8')

for density,size in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
    target=ROOT/'android/app/src/main/res'/f'mipmap-{density}'
    for name in ['ic_launcher.png','ic_launcher_round.png']:
        artwork(background=BLUSH).resize((size,size),Image.Resampling.LANCZOS).save(target/name)
    # Adaptive safe zone: the mark remains inside the central 66/108 width.
    foreground=Image.new('RGBA',(108*S,108*S))
    scaled=artwork().resize((90*S,90*S),Image.Resampling.LANCZOS)
    foreground.alpha_composite(scaled,(9*S,9*S))
    foreground.resize((round(size*108/48),round(size*108/48)),Image.Resampling.LANCZOS).save(target/'ic_launcher_foreground.png')

(OUT/'motion_spec.md').write_text('''# SusikaQueenPiano static mark

Personality: affectionate, playful, graceful. Context: static header, launcher and native splash artwork. No brand animation is introduced.

The source artwork is a supersampled procedural design: four rounded piano keys and a little crown. Pixel2Motion fits it with four analytic rounded rectangles, one intentional angular crown silhouette and a rounded crown band. Stable semantic ids keep the mark motion-ready. The angular crown points are intentional; smooth edges use analytic primitives, with no traced pixel contours. The production SVG is transparent, dark rose and plum for the cream/blush interface.

Geometry QA uses the skill's browser renderer against a dark monochrome mask with the exact same source geometry. Color artwork and geometry QA are separate so thresholding cannot conflate color and silhouette. Browser render, overlay, metrics and zoom evidence are retained here. This proportional static update does not require motion HTML or a choreography strip.
''',encoding='utf-8')
print('Created crowned piano artwork and Android icon assets')

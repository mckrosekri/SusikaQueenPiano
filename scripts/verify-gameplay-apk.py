"""Verify that the delivered APK contains the exact current web build."""
from pathlib import Path
import hashlib, json, zipfile, re, sys
from datetime import datetime, timezone

apk = Path('output/android/SusikaQueenPiano-debug.apk')
files = [path for path in Path('dist').rglob('*') if path.is_file()]
with zipfile.ZipFile(apk) as package:
    mismatches = [str(path) for path in files if package.read('assets/public/' + path.relative_to('dist').as_posix()) != path.read_bytes()]
    songs = sum(name.startswith('assets/public/audio/') and name.endswith('.mp3') for name in package.namelist())
    test_markers = [str(path) for path in files if path.suffix == '.js' and any(marker in path.read_text(encoding='utf-8') for marker in ['Little Piano Test', 'synthetic-qa', 'visual-test-piano', 'gameplayFixtures', 'qa=gameplay'])]
gradle = Path('android/app/build.gradle').read_text(encoding='utf-8')
report = {'verifiedUtc': datetime.now(timezone.utc).isoformat(), 'versionName': re.search(r'versionName "([^"]+)"', gradle).group(1), 'versionCode': int(re.search(r'versionCode (\d+)', gradle).group(1)), 'chartVersion': 'afterbeat-chart-v6', 'apkSHA256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'apkBytes': apk.stat().st_size, 'distFiles': len(files), 'exactDistAssetMatches': len(files) - len(mismatches), 'mismatches': mismatches, 'bundledSongs': songs, 'developmentFixtureMarkers': test_markers}
report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('output/android/combo-fire-packaged-verification.json')
report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
assert not mismatches and not test_markers and songs == 10

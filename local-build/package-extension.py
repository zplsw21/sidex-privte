from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parent
source = root / 'thief-book'
package = json.loads((source / 'package.json').read_text())
output = root / f"thief-book-sidex-{package['version']}.vsix"
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(package['name'])}" Version="{escape(package['version'])}" Publisher="{escape(package['publisher'])}"/>
    <DisplayName>{escape(package['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(package['description'])}</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(package['engines']['vscode'])}"/></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
'''
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', content_types)
    for file in sorted(source.rglob('*')):
        if file.is_file() and 'test' not in file.relative_to(source).parts:
            archive.write(file, 'extension/' + str(file.relative_to(source)))
with ZipFile(output) as archive:
    for file in source.rglob('*'):
        if file.is_file() and 'test' not in file.relative_to(source).parts:
            assert archive.read('extension/' + str(file.relative_to(source))) == file.read_bytes()
print(output)

from pathlib import Path
import xml.etree.ElementTree as ET
root=ET.parse(Path('assets/architecture.svg')).getroot()
assert root.tag=='{http://www.w3.org/2000/svg}svg'
assert root.find('{http://www.w3.org/2000/svg}title') is not None
assert root.find('{http://www.w3.org/2000/svg}desc') is not None
for element in root.iter():
 assert element.tag.split('}')[-1] not in ('script','image','foreignObject')
 for key,value in element.attrib.items():
  assert not key.lower().startswith('on')
  if key.endswith('href'):assert value.startswith('#')
print('SVG: valid standalone vector XML')

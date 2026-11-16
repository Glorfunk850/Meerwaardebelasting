from pathlib import Path
here = Path(__file__).parent
html = (here / "template.html").read_text()
for marker, f in (("/*ENGINE*/", "engine.js"), ("/*BOLERO*/", "bolero.js"), ("/*XLSX*/", "xlsx.js"), ("/*SAXO*/", "saxo.js"), ("/*BEWIJS*/", "bewijs.js"), ("/*PDF*/", "pdf.js"), ("/*APP*/", "app.js")):
    js = (here / f).read_text()
    assert "</script" not in js.lower()
    html = html.replace(marker, js)
(here / "index.html").write_text(html)
print("index.html", len(html), "bytes")

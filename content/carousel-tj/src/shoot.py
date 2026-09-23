from playwright.sync_api import sync_playwright
import pathlib, os
out=pathlib.Path("out"); out.mkdir(exist_ok=True)
url="file://"+os.path.abspath("slides.html")
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])
    pg=b.new_page(viewport={"width":1080,"height":1350}, device_scale_factor=1)
    pg.goto(url, wait_until="load", timeout=120000)
    pg.wait_for_timeout(2500)
    els=pg.query_selector_all(".slide")
    print("slides found:", len(els))
    for i,el in enumerate(els,1):
        el.screenshot(path=str(out/f"slide_{i:02d}.jpg"), type="jpeg", quality=92)
    b.close()
print(sorted(os.listdir("out")))

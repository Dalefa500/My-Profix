from playwright.sync_api import sync_playwright
import os, sys, pathlib
out=pathlib.Path("hero_out"); out.mkdir(exist_ok=True)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])
    pg=b.new_page(viewport={"width":1080,"height":1350})
    pg.goto("file://"+os.path.abspath("hero.html"), wait_until="load", timeout=120000)
    pg.wait_for_timeout(1500)
    for el in pg.query_selector_all(".slide"):
        k=el.get_attribute("id")
        el.screenshot(path=str(out/f"{k}.jpg"), type="jpeg", quality=93)
        print("shot", k)
    b.close()

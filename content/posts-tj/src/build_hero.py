import base64, os, pathlib, sys

def b64(p, mime="image/png"):
    return f"data:{mime};base64,"+base64.b64encode(open(p,"rb").read()).decode()
FONT=b64("fonts/NotoSans.ttf","font/ttf")
BG=b64("assets/bg1.png")
LOGO=b64("assets/logo_red.png")
RED="#D2102A"

PRODUCTS={
 "shpat": dict(img="shpat", hook="Деворҳоятон<br>ноҳамвор?", name="ШПАТЛЕВКА",
               type="Шпатлёвкаи дохилӣ", weight="25 кг", use="Пеш аз ранг ва обои", h=742),
 "blue":  dict(img="blue", hook="Девору шифти<br>ҳамвор мехоҳед?", name="FIZERBERG",
               type="Штукатуркаи гипси", weight="30 кг", use="Барои корҳои дохилӣ", h=742),
 "rovn":  dict(img="rovn", hook="Фаршатон<br>каҷ аст?", name="РОВНИТЕЛЬ",
               type="Барои ҳамвор кардани фарш", weight="25 кг", use="Барои корҳои дохилӣ", h=742),
 "k700":  dict(img="k700", hook="Кошин<br>мегузоред?", name="КЛЕЙ 700",
               type="Ширеши кошини тақвиятдода", weight="25 кг", use="Барои корҳои дохилӣ", h=742),
 "k800":  dict(img="k800", hook="Кошин ба<br>фасад мегузоред?", name="КЛЕЙ 800",
               type="Ширеши кошини тақвиятдода", weight="25 кг", use="Барои дохил ва фасад", h=742),
 "kraska_f": dict(img="kraska_f", hook="Фасадро ранг<br>кардан мехоҳед?", name="КРАСКА ФАСАДНАЯ",
               type="Ранги акрилӣ", weight="20 кг", use="Барои корҳои берунӣ", h=430),
 "grunt_f": dict(img="grunt_f", hook="Ранг хуб<br>часпидан гирад", name="ГРУНТОВКА ФАСАДНАЯ",
               type="Грунтовкаи акрилӣ", weight="20 кг", use="Барои корҳои берунӣ", h=430),
 "grunt_v": dict(img="grunt_v", hook="Девор пеш аз<br>ранг омода шавад", name="ГРУНТОВКА ВНУТРЕННЯЯ",
               type="Грунтовкаи акрилӣ", weight="20 кг", use="Барои корҳои дохилӣ", h=430),
 "dojdik": dict(img="dojdik", hook="Деворро зебо<br>кардан мехоҳед?", name="ДОЖДИК",
               type="Штукатуркаи ороишӣ", weight="25 кг", use="Барои дохил ва фасад", h=430),
 "shuba":  dict(img="shuba", hook="Фасади зебо<br>мехоҳед?", name="ШУБА",
               type="Штукатуркаи ороишӣ", weight="20 кг", use="Барои дохил ва фасад", h=430),
}

PLANE = ('<svg viewBox="0 0 24 24" width="66" height="66" fill="#fff">'
         '<path d="M2.2 21.4 23 12 2.2 2.6l.1 7.3L17 12 2.3 14.1z"/></svg>')

def slide(key):
    p=PRODUCTS[key]
    img=b64(f"cut/{p['img']}.png")
    return f'''<div class="slide" id="{key}">
  <img class="bg" src="{BG}">
  <div class="shadow" style="width:{int(p['h']*0.66)}px"></div>
  <img class="hero" style="height:{p['h']}px" src="{img}">
  <div class="top"><img class="logo" src="{LOGO}"><span class="tag">Сифати беҳтарин</span></div>
  <div class="left">
    <h1>{p['hook']}</h1>
    <div class="rule"></div>
    <div class="name">{p['name']}</div>
    <div class="type">{p['type']}</div>
    <div class="badge">{p['weight']}</div>
    <div class="use">{p['use']}</div>
  </div>
  <div class="bar"><span class="plane">{PLANE}</span><span class="div"></span>
    <span class="cta">Барои фармоиш ба Direct нависед</span></div>
</div>'''

keys = sys.argv[1:] or list(PRODUCTS)
html=f'''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:"NS";src:url("{FONT}") format("truetype");font-weight:100 900;}}
*{{margin:0;padding:0;box-sizing:border-box;}}
body{{font-family:"NS",sans-serif;background:#111;}}
.slide{{width:1080px;height:1350px;position:relative;overflow:hidden;background:#fff;}}
.bg{{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}}
.hero{{position:absolute;right:38px;bottom:252px;width:auto;
  filter:drop-shadow(-26px 22px 26px rgba(90,70,55,.34));z-index:3;}}
.shadow{{position:absolute;right:62px;bottom:232px;height:54px;border-radius:50%;
  background:rgba(78,60,44,.5);filter:blur(24px);z-index:2;}}
.top{{position:absolute;left:70px;top:78px;display:flex;align-items:center;gap:26px;z-index:5;}}
.logo{{height:50px;width:auto;}}
.tag{{font-size:36px;font-weight:700;color:#16181B;}}
.left{{position:absolute;left:70px;top:206px;width:520px;z-index:5;}}
h1{{font-size:78px;line-height:1.14;font-weight:800;color:#0E1013;letter-spacing:-1px;}}
.rule{{width:132px;height:7px;background:{RED};margin:36px 0 30px;border-radius:4px;}}
.name{{font-size:64px;font-weight:800;color:#0E1013;line-height:1.04;letter-spacing:-.5px;}}
.type{{font-size:56px;font-weight:800;color:{RED};line-height:1.1;margin-top:10px;}}
.badge{{display:inline-block;margin-top:26px;background:{RED};color:#fff;font-size:56px;
  font-weight:800;padding:8px 32px 12px;border-radius:16px;}}
.use{{margin-top:28px;font-size:37px;font-weight:600;color:#16181B;}}
.bar{{position:absolute;left:0;right:0;bottom:0;height:160px;background:{RED};
  display:flex;align-items:center;justify-content:center;padding:0 40px;z-index:6;}}
.plane{{display:flex;align-items:center;}}
.div{{width:4px;height:74px;background:rgba(255,255,255,.85);margin:0 28px;border-radius:2px;}}
.cta{{color:#fff;font-size:43px;font-weight:800;white-space:nowrap;}}
</style></head><body>{''.join(slide(k) for k in keys)}</body></html>'''
pathlib.Path("hero.html").write_text(html,encoding="utf-8")
print("built:", keys)

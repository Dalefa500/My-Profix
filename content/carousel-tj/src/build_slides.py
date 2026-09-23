import base64, os, pathlib

def b64(p):
    return "data:image/png;base64,"+base64.b64encode(open(p,"rb").read()).decode()
FONT="data:font/ttf;base64,"+base64.b64encode(open("fonts/NotoSans.ttf","rb").read()).decode()
RAINBOW="linear-gradient(90deg,#D01C2A 0 14.3%,#E8601C 14.3% 28.6%,#F2B705 28.6% 42.9%,#3AA757 42.9% 57.2%,#00A0B0 57.2% 71.5%,#1160B0 71.5% 85.8%,#7A3E9D 85.8% 100%)"
def rgba(h,a):
    h=h.lstrip("#"); r,g,b=int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)
    return f"rgba({r},{g},{b},{a})"

BAGS=["shpat","rovn","red","blue","k700","k800"]
BUCKETS=["kraska_f","grunt_f","grunt_v","dojdik","shuba"]
IMG={k:b64(f"cut/{k}.png") for k in BAGS+BUCKETS}

slides=[
 dict(kind="cover", accent="#C8102E",
      title="ҲАМА БАРОИ<br>ТАЪМИР",
      sub="Омехтаҳои хушк · Ранг · Грунтовка · Штукатуркаи ороишӣ",
      foot="Истеҳсоли ватанӣ · Душанбе"),
 dict(kind="product", accent="#D01C2A", img="red",
      kicker="Штукатурка гипсовая", h1="ШТУКАТУРКАИ ГАҶӢ", h2="FIZERBERG",
      badge="30 кг · сурх",
      bullets=["Ҳамворкунии шифт ва<br>деворҳои бетонӣ","Пуркунандаи сафед","Барои корҳои дохилӣ"]),
 dict(kind="product", accent="#1160B0", img="blue",
      kicker="Штукатурка гипсовая", h1="ШТУКАТУРКАИ ГАҶӢ", h2="FIZERBERG",
      badge="30 кг · кабуд",
      bullets=["Ҳамон омехта —<br>пуркунандааш хокистарранг","Хосияташ бо сурх якхела","Барои корҳои дохилӣ"]),
 dict(kind="product", accent="#1C8FD8", img="shpat",
      kicker="Шпатлевка внутренняя", h1="ШПАТЛЁВКАИ ДОХИЛӢ", h2="",
      badge="25 кг",
      bullets=["Барои корҳои<br>дарунии бино","Сатҳи ҳамвор пеш аз<br>ранг ва обои"]),
 dict(kind="product", accent="#4A4F55", img="rovn",
      kicker="Ровнитель для пола", h1="ҲАМВОРКУНАНДА<br>БАРОИ ФАРШ", h2="",
      badge="25 кг",
      bullets=["Ҳамвор кардани фарш<br>дар дохили бино","Асоси боэътимод барои<br>кошин ва ламинат"]),
 dict(kind="product", accent="#E8601C", img="k700",
      kicker="Плиточный клей 700", h1="ШИРЕШИ КОШИН 700", h2="ТАҚВИЯТДОДАШУДА",
      badge="25 кг",
      bullets=["Барои кошинкорӣ дар<br>дохили бино","Кошин ба фарш<br>ва ба девор"]),
 dict(kind="product", accent="#93202D", img="k800",
      kicker="Плиточный клей 800", h1="ШИРЕШИ КОШИН 800", h2="ТАҚВИЯТДОДАШУДА",
      badge="25 кг",
      bullets=["Дохили бино ва фасад","Гранит, керамогранит,<br>санги табиӣ","Универсалӣ —<br>700-ро иваз мекунад"]),
 dict(kind="buckets", accent="#7A3E9D",
      kicker="Готовые составы", h1="МАҲСУЛОТИ ТАЙЁР",
      bullets=["Ранги фасадӣ ва дохилӣ · 20 кг","Грунтовкаи фасадӣ ва дохилӣ · 20 кг","Штукатуркаи ороишӣ «Дождик» ва «Шуба»"]),
 dict(kind="cta", accent="#C8102E",
      title="ФАРМОИШ<br>ДИҲЕД",
      lines=["Ба Direct нависед — ҷавоб 24/7","WhatsApp +992 03 522 85 85","Душанбе · таҳвил ба объект"],
      foot="PROFIX — тамоми рангинкамони зиндагӣ!"),
]

def bl(bs,a):
    return "".join(f'<li><span class="dot" style="background:{a}"></span>{b}</li>' for b in bs)

parts=[]; n=len(slides)
for i,s in enumerate(slides,1):
    a=s["accent"]
    if s["kind"]=="cover":
        bags="".join(
            f'<img class="cbag" style="left:{24+k*160}px" src="{IMG[b]}">'
            for k,b in enumerate(BAGS))
        buckets="".join(
            f'<img class="cbuck" style="left:{40+k*188}px" src="{IMG[b]}">'
            for k,b in enumerate(BUCKETS))
        parts.append(f'''<div class="slide cover" style="background:{a}">
  <div class="glow"></div>
  <div class="wmbig">PROFIX</div>
  <div class="cpad">
    <div class="brand">PROFIX<div class="rb"></div></div>
    <h1 class="ctitle">{s["title"]}</h1>
    <div class="csub">{s["sub"]}</div>
    <div class="cfoot"><span>{s["foot"]}</span><span class="swipe">Ҷобаҷо кунед →</span></div>
  </div>
  <div class="stage">{bags}{buckets}</div>
  <div class="rainbow"></div></div>''')
    elif s["kind"]=="cta":
        lines="".join(f'<div class="ctaline">{l}</div>' for l in s["lines"])
        parts.append(f'''<div class="slide cta" style="background:{a}">
  <div class="glow"></div>
  <div class="wmbig">PROFIX</div>
  <div class="cpad">
    <div class="brand">PROFIX<div class="rb"></div></div>
    <h1 class="ctatitle">{s["title"]}</h1>
    <div class="ctabox">{lines}</div>
  </div>
  <img class="ctaprod" src="{IMG["red"]}">
  <div class="cfoot2">{s["foot"]}</div>
  <div class="rainbow"></div></div>''')
    elif s["kind"]=="buckets":
        pos=[(0,0),(175,0),(350,0),(88,292),(263,292)]
        grp="".join(f'<img class="bk" style="left:{pos[k][0]}px;top:{pos[k][1]}px" src="{IMG[b]}">' for k,b in enumerate(BUCKETS))
        parts.append(f'''<div class="slide prod">
  <div class="panel" style="background:{rgba(a,0.10)}"></div>
  <div class="topbar" style="background:{a}"></div>
  <div class="head"><div class="wm">PROFIX</div><div class="num" style="color:{a}">{i}/{n}</div></div>
  <div class="col">
    <div class="kicker">{s["kicker"]}</div>
    <div class="h1">{s["h1"]}</div>
    <ul class="bul wide">{bl(s["bullets"],a)}</ul>
  </div>
  <div class="bgrid">{grp}</div>
  <div class="rainbow"></div></div>''')
    else:
        h2=f'<div class="h2" style="color:{a}">{s["h2"]}</div>' if s["h2"] else ""
        parts.append(f'''<div class="slide prod">
  <div class="panel" style="background:{rgba(a,0.10)}"></div>
  <div class="topbar" style="background:{a}"></div>
  <div class="head"><div class="wm">PROFIX</div><div class="num" style="color:{a}">{i}/{n}</div></div>
  <img class="hero" src="{IMG[s["img"]]}">
  <div class="col">
    <div class="kicker">{s["kicker"]}</div>
    <div class="h1">{s["h1"]}</div>{h2}
    <div class="badge" style="background:{a}">{s["badge"]}</div>
    <ul class="bul">{bl(s["bullets"],a)}</ul>
  </div>
  <div class="rainbow"></div></div>''')

html=f'''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:"NS";src:url("{FONT}") format("truetype");font-weight:100 900;}}
*{{margin:0;padding:0;box-sizing:border-box;}}
body{{font-family:"NS",sans-serif;background:#111;}}
.slide{{width:1080px;height:1350px;position:relative;overflow:hidden;background:#fff;}}
.rainbow{{position:absolute;bottom:0;left:0;right:0;height:14px;background:{RAINBOW};z-index:9;}}
/* product */
.topbar{{position:absolute;top:0;left:0;right:0;height:14px;z-index:5;}}
.panel{{position:absolute;right:-180px;top:120px;width:860px;height:1080px;border-radius:120px;transform:rotate(-6deg);}}
.head{{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:52px 70px 0;z-index:6;}}
.wm{{font-weight:800;font-size:38px;letter-spacing:2px;color:#17181A;}}
.num{{font-weight:700;font-size:30px;}}
.hero{{position:absolute;right:28px;bottom:74px;height:856px;width:auto;filter:drop-shadow(0 26px 34px rgba(0,0,0,.28));z-index:3;}}
.col{{position:absolute;left:70px;top:210px;width:430px;z-index:6;}}
.kicker{{font-size:26px;font-weight:600;color:#8A9099;}}
.h1{{margin-top:10px;font-size:50px;line-height:1.08;font-weight:800;color:#17181A;letter-spacing:-.3px;}}
.h2{{margin-top:8px;font-size:29px;font-weight:800;letter-spacing:.6px;}}
.badge{{display:inline-block;margin-top:22px;padding:11px 24px;border-radius:999px;color:#fff;font-size:27px;font-weight:700;}}
.bul{{margin-top:28px;list-style:none;}}
.bul li{{position:relative;padding-left:32px;font-size:29px;line-height:1.36;color:#3C4249;margin-bottom:18px;font-weight:500;}}
.bul.wide li{{font-size:31px;}}
.dot{{position:absolute;left:0;top:13px;width:15px;height:15px;border-radius:50%;}}
.bgrid{{position:absolute;right:46px;bottom:120px;width:640px;height:560px;z-index:3;}}
.bgrid img.bk{{position:absolute;width:290px;filter:drop-shadow(0 18px 24px rgba(0,0,0,.22));}}
/* cover + cta */
.cover,.cta{{color:#fff;}}
.glow{{position:absolute;inset:0;background:radial-gradient(900px 620px at 78% 8%, rgba(255,255,255,.16), rgba(255,255,255,0) 70%);}}
.wmbig{{position:absolute;right:-60px;top:596px;font-size:190px;font-weight:800;color:rgba(255,255,255,.06);letter-spacing:6px;}}
.cpad{{position:absolute;top:70px;left:70px;right:70px;z-index:4;}}
.brand{{font-size:54px;font-weight:800;letter-spacing:3px;}}
.rb{{width:230px;height:10px;margin-top:12px;background:{RAINBOW};border-radius:6px;}}
.ctitle{{margin-top:44px;font-size:108px;line-height:1.0;font-weight:800;letter-spacing:-2px;}}
.csub{{margin-top:24px;font-size:28px;font-weight:500;opacity:.92;line-height:1.4;max-width:820px;}}
.stage{{position:absolute;left:0;right:0;bottom:0;height:780px;z-index:3;}}
.cbag{{position:absolute;bottom:250px;height:382px;filter:drop-shadow(0 22px 26px rgba(0,0,0,.35));}}
.cbuck{{position:absolute;bottom:92px;height:202px;filter:drop-shadow(0 16px 20px rgba(0,0,0,.35));}}
.cfoot{{margin-top:40px;display:flex;justify-content:space-between;align-items:center;font-size:27px;font-weight:600;opacity:.95;}}
.swipe{{background:rgba(255,255,255,.2);border-radius:999px;padding:13px 26px;font-size:26px;font-weight:600;}}
.ctatitle{{margin-top:70px;font-size:104px;font-weight:800;line-height:1.0;letter-spacing:-2px;}}
.ctabox{{margin-top:50px;display:flex;flex-direction:column;gap:24px;max-width:640px;}}
.ctaline{{font-size:38px;font-weight:600;background:rgba(255,255,255,.15);border-radius:18px;padding:24px 30px;}}
.ctaprod{{position:absolute;right:-40px;bottom:52px;height:600px;filter:drop-shadow(0 26px 30px rgba(0,0,0,.4));z-index:2;}}
.cfoot2{{position:absolute;bottom:40px;left:70px;font-size:31px;font-weight:700;z-index:6;}}
</style></head><body>{"".join(parts)}</body></html>'''
pathlib.Path("slides.html").write_text(html,encoding="utf-8")
print("slides:",n,"KB:",len(html)//1024)

---
theme: default
title: Omarchy 向けにアクキー、アクスタ作成アプリを作った
info: kakomu の LT（5 分）
colorSchema: dark
aspectRatio: 16/9
transition: fade
download: false
fonts:
  sans: BIZ UDPGothic
  mono: JetBrains Mono
  weights: '400,700'
layout: center
class: title-slide
---

<div class="keychain">
  <p class="eyebrow">kakomu</p>
  <h1>Omarchy 向けに<br>アクキー、アクスタ作成アプリを作った</h1>
</div>

<p class="byline">石原 淳也 <span>@jishiha</span></p>

<!--
タイトルの枠はアプリの「切る線」、上の丸は「キーホルダーの穴」のつもり。
-->

---
layout: default
class: profile-slide
---

# 自己紹介

<div class="profile">
  <div class="who">
    <img src="https://github.com/champierre.png?size=400" alt="" class="avatar">
    <p class="name">石原 淳也</p>
    <p class="handles">X <code>@jishiha</code><br>GitHub <code>@champierre</code></p>
  </div>

  <ul class="facts">
    <li><strong>合同会社つくる社</strong> 代表社員／<strong>株式会社まちクエスト</strong> 代表取締役</li>
    <li><strong>青山学院大学</strong> プロジェクト准教授<br><span class="sub">青学つくまなラボ フェロー</span></li>
    <li>フリーランスで、おもに <strong>Ruby on Rails</strong> のプロジェクトを手伝う</li>
    <li><strong>まちクエスト</strong> を運営<br><span class="sub">https://machique.st</span></li>
  </ul>
</div>

<p class="bridge-line">kakomu は、<strong>つくまなラボ</strong>でアクキー・アクスタを作るために作りました</p>

---
layout: default
class: machine-slide
---

<div class="machine-head">

# わたしの Omarchy マシン

<p class="spec">GMKtec ミニPC AMD Ryzen7 8845HS搭載<br><span class="price">￥76,580</span></p>

</div>

<figure class="machine">
  <img src="./omarchy.jpg" alt="GMKtec のミニ PC">
</figure>

---
layout: default
class: arch-slide
---

# kakomu のアーキテクチャ

<p class="lede">Tauri v2 — 触って動かすのはフロント、時間のかかる計算は Rust</p>

<div class="arch">
  <section class="box front">
    <header><span class="tag">WebView</span>TypeScript + Solid.js</header>
    <ul>
      <li>キャンバスは <strong>SVG DOM</strong><br>当たり判定はブラウザ任せ</li>
      <li>ドキュメントと undo／redo</li>
      <li>点のドラッグ、穴の配置とチェック</li>
      <li>切るデータ <code>.svg</code> はここで組み立て</li>
    </ul>
  </section>

  <div class="bridge">
    <p class="bridge-title">IPC</p>
    <p class="wire">invoke<span>→</span></p>
    <p class="wire back"><span>←</span>Channel（進捗）</p>
    <p class="bridge-note">画像は JSON に載せず<br><code>asset://</code> で渡す</p>
  </div>

  <section class="box core">
    <header><span class="tag">Rust</span>core</header>
    <dl>
      <dt>matting</dt>
      <dd><code>ort</code> で ONNX 推論（<code>u2netp</code> ほか）<br><strong>画像は外に出さない</strong></dd>
      <dt>cutline</dt>
      <dd class="pipeline">
        <span>アルファ</span><i>→</i><span>距離場で 3mm 広げる</span><i>→</i><span>細い所を太らせる</span><i>→</i><span>輪郭抽出</span><i>→</i><span>三次ベジェ</span>
      </dd>
      <dt>export</dt>
      <dd>PDF は<strong>ライブラリなしで自前</strong>（TrimBox・透過）</dd>
    </dl>
  </section>
</div>

<div class="outputs">
  <p><code>名前_切る.svg</code><i>→</i>レーザー加工機 xTool P3</p>
  <p><code>名前_印刷.pdf</code><i>→</i>UV プリンター Roland BD-8</p>
  <p class="dist">GitHub Actions で dmg／msi／AppImage／deb<i>→</i>Omarchy は AUR <code>kakomu-bin</code></p>
</div>

<!--
- Tauri を選んだのは、OS の WebView を使うので Wayland / Hyprland でも素直に動くから。バイナリも軽い
- 切る線は、仕様では Clipper2 でポリゴンをオフセットする予定だったが、入力がラスタなので距離場にした。角が自然に丸くなり、自己交差も原理的に起きない
- 細い所は「消す」のではなく「太らせる」。消すと尻尾やリボンが線からはみ出す
- Omarchy の落とし穴: xdg-desktop-portal-gtk が無いとファイルダイアログが出ない。描画が崩れたら WEBKIT_DISABLE_DMABUF_RENDERER=1
-->

---
layout: default
class: aur-slide
---

# AUR の新規登録が一時停止中

<p class="lede">自動で作られるアカウントが大量に来ているため、新しい登録を止めている（HTTP 503）</p>

<figure class="screenshot">
  <img src="./aur-register.png" alt="aur.archlinux.org/register の「New account registration is temporarily closed」の画面">
</figure>

---
layout: default
class: remote-slide
---

# Omarchy にリモートでつなぐ

<p class="lede">Sunshine × Moonlight を、Tailscale の上で使う</p>

<div class="arch remote">
  <section class="box client">
    <header><span class="tag">Moonlight</span>手元のパソコン</header>
    <ul>
      <li>送られてきた画面を表示する</li>
      <li>キーボードとマウスの操作を送る</li>
    </ul>
  </section>

  <div class="bridge">
    <p class="bridge-title">Tailscale</p>
    <p class="wire back"><span>←</span>画面</p>
    <p class="wire">入力<span>→</span></p>
    <p class="bridge-note">ポートを開けなくても<br>別のネットワークから届く</p>
  </div>

  <section class="box host">
    <header><span class="tag">Sunshine</span>Omarchy マシン</header>
    <ul>
      <li>画面を取り込んで、動画にして送る</li>
      <li>届いた操作をそのまま反映する</li>
      <li>kakomu はこちらで動いている</li>
    </ul>
  </section>
</div>

---
layout: center
class: demo-slide
---

<div class="keychain">
  <h1>デモ</h1>
</div>

---
layout: default
class: media-slide
---

# レーザーカッター

<p class="model">xTool P3</p>
<p class="what"><code>名前_切る.svg</code> の線に沿って、アクリルを切る</p>

<SlidevVideo class="clip" autoplay autoreset="slide" muted loop playsinline print-timestamp="10">
  <source src="./lazercutter.mp4" type="video/mp4">
</SlidevVideo>

---
layout: default
class: media-slide
---

# UV プリンター

<p class="model">Roland BD-8</p>
<p class="what"><code>名前_印刷.pdf</code> を、アクリルに印刷する</p>

<SlidevVideo class="clip" autoplay autoreset="slide" muted loop playsinline print-timestamp="10">
  <source src="./uv.mp4" type="video/mp4">
</SlidevVideo>

---
layout: center
class: title-slide end-slide
---

<div class="keychain">
  <p class="eyebrow">kakomu</p>
  <h1>ありがとうございました</h1>
</div>

<div class="links">
  <p>GitHub <code>github.com/tukumanalab/kakomu</code></p>
  <img src="./kakomu-qr.svg" alt="github.com/tukumanalab/kakomu の QR コード" class="qr">
</div>

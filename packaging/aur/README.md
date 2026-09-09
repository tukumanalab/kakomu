# AUR パッケージ

Arch Linux（および omarchy）向けの配布物です。ここにあるのは
**インストールの手順書（`PKGBUILD`）だけ**で、アプリ本体は入っていません。
実際のダウンロードとビルドは、利用者の手元で行われます。

| パッケージ | 中身 | 向いている人 |
|---|---|---|
| `kakomu-bin` | Releases のビルド済み `.deb` を展開して入れる | ふつうはこちら。速い |
| `kakomu` | ソースからビルドする | 手を入れたい人 |

## なぜ AppImage ではなくこちらを勧めるか

`PKGBUILD` に依存パッケージを書いてあるので、**一行で依存ごと入ります**。

```sh
yay -S kakomu-bin
```

AppImage を手で入れる場合、`webkit2gtk-4.1` や `xdg-desktop-portal-gtk` を
自分で揃える必要があります。特に portal は、入れ忘れると
**「絵を入れる」を押してもファイルダイアログが出ない**という分かりにくい
壊れ方をします。AUR 経由ならここを踏みません。

更新も `yay -Syu` で他のソフトと一緒に来ます。

## AUR に出す前に、手元で試す

AUR に登録しなくても、omarchy 上でそのまま試せます。

```sh
cd packaging/aur/kakomu-bin
makepkg -si
```

**最初の 1 回はこれで確かめてください。** `depends` は Cargo の機能構成から
決めたもので、実機で確かめていません。起動しない場合は不足しているものが
あるので、次で確認して `depends` に足します。

```sh
ldd /usr/bin/kakomu | grep 'not found'
```

## リリースのたびにやること

```sh
./packaging/aur/update.sh 0.1.0     # pkgver と sha256 を書き換える
```

`.SRCINFO` の生成には `makepkg` が要るので、Arch 上で実行してください。
そのうえで AUR に push します。

```sh
git clone ssh://aur@aur.archlinux.org/kakomu-bin.git aur-kakomu-bin
cp packaging/aur/kakomu-bin/{PKGBUILD,.SRCINFO} aur-kakomu-bin/
cd aur-kakomu-bin && git commit -am "v0.1.0" && git push
```

## 初回だけ必要な準備

1. https://aur.archlinux.org でアカウントを作る
2. 公開鍵（`~/.ssh/id_ed25519.pub`）をアカウント設定に登録する
3. 上の `git clone ssh://aur@...` で空のリポジトリが取れる（名前は先着順）

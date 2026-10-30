# mi3Tweaks

[Spicetify](https://spicetify.app/)拡張機能です。自分が欲しかった機能をまとめてます。

### 機能

**Cover Skip**
- 再生された曲がカバー曲と判定されると、自動でスキップします。
- 曲名で判定します(例: `(Cover)`、`[Piano Cover]`、`- Acoustic Cover`、`covered by`、`karaoke version`、`歌ってみた`)。
- アーティスト名・アルバム名でも判定できます(カラオケ・カバー系のレーベル名など。デフォルトON)。
- 曲を右クリック →「mi3Tweaks」から、曲ごとに設定できます。
  - 「この曲はスキップしない」(ホワイトリスト): 誤検出の対策
  - 「この曲を常にスキップ」(ブラックリスト): 見逃しの対策
- 10曲連続でスキップした場合は、スキップを続けずに再生を停止します。
- Podcastのエピソードは判定しません。

**YouTube Link Copy**
- 曲を右クリック →「mi3Tweaks」→「YouTubeリンクをコピー」を選ぶと、「曲名 アーティスト名」で検索したYouTubeのリンクをコピーします。
- YouTube Data API v3のキーを設定すると、検索結果1件目の動画への直リンクをコピーします。
- キーがない場合は、YouTubeの検索結果ページのリンクをコピーします。

**Volume Hotkeys**
- 数字キーで音量を10%刻みに設定します(`1`=10%、`2`=20%、…`9`=90%、`0`=100%)。
- `M`キーでミュートを切り替えます。ミュートを解除すると元の音量に戻ります。
- 検索欄などで文字を入力しているときは反応しません。

### 設定

右上のプロフィールメニュー →「mi3Tweaks Settings」から、各機能のON/OFF、ホワイトリスト・ブラックリストの管理、YouTube APIキーの設定ができます。

### インストール

- Marketplace: 「mi3Tweaks」を検索してインストールします。
- Manual: [`mi3Tweaks.js`](mi3Tweaks.js)を`%APPDATA%\spicetify\Extensions`に置いて、次のコマンドを実行します。
  ```sh
  spicetify config extensions mi3Tweaks.js
  spicetify apply
  ```

### 注意

- 設定はSpotifyの`localStorage`に`mi3Tweaks:`から始まるキーで保存されます。
- YouTube APIキーは平文で保存されます。Google Cloud Consoleでキーを作るときは、使えるAPIをYouTube Data API v3だけに制限してください。

## ライセンス

[MIT](LICENSE)

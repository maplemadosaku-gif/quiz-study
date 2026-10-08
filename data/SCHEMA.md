# データ形式（デッキJSON）

`data/index.json` に列挙された各JSONファイルが1つの「デッキ」（学習単位）です。

```json
{
  "id": "countries-asia",            // ファイル名と同じ。英小文字とハイフン
  "title": "アジアの国々",
  "category": "地理",                 // 地理 / 日本史 / 中国史 / 世界史 / 文学賞 / 映画賞 / 音楽賞 など
  "description": "一言説明",
  "columns": [
    {"key": "flag", "label": "国旗", "type": "flag"},   // type:flag = ISO 3166-1 alpha-2 小文字 (例 "jp")
    {"key": "name", "label": "国名"},
    {"key": "capital", "label": "首都"}
  ],
  "quizzes": [
    {"q": "flag", "a": "name", "label": "国旗 → 国名"},
    {"q": "name", "a": "capital", "label": "国名 → 首都"}
  ],
  "rows": [
    {"flag": "jp", "name": "日本", "capital": "東京"}
  ]
}
```

- 値はすべて文字列。
- 別解は `|` 区切り（最初が表示用、すべて正解扱い）。例: `"ティモール・レステ|東ティモール"`
- 複数項目の列挙は `、` 区切り。例: `"大阪、名古屋、横浜"`
- 空欄は `""`。
- 列 `note` は補足（クイズには使わず一覧と解説に表示）。
- 年の列は西暦の数字文字列（紀元前は `"前221"`）。

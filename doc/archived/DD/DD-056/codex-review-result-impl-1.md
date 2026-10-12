コミット時点のソースとテストを確認し、操作ログの重複・未捕捉 rejection・不正な thenable による接続断を再現しました。未コミット変更は対象外とし、全回帰テストは再実行していません。

Full review comments:

- [P1] 認可ラッパーが戻るまで再入ガードを保持する — C:\repo\spreadjs\packages\server-hono\src\server.ts:819-820
  永続化ありで `onDiagnostic` が `operation-denied` に対して `server.submit` を呼ぶと、①認可フックが false を返す、②ここでガードが解除される、③診断からの submit が受理される、④外側の `PersistentRoom.handleMessage` も同じ受理を永続化する、という順序でログが重複します。実 WS で oplog の revision が `[1,2,2]` になることを再現しました。このログは再起動時の連番検査で復旧に失敗します。[契約の再入禁止](C:/repo/spreadjs/doc/archived/DD/DD-056/contract.md#L117)を満たすため、戻り値の検査・thenable 処理・診断までガードを保持するか、診断を sequencer 処理後に遅延配送してください。

- [P1] 関数型の thenable にも rejection ハンドラを付ける — C:\repo\spreadjs\packages\server-hono\src\server.ts:835-837
  JS consumer が関数型の thenable を返す場合、`isPromiseLike` は `typeof value === 'object'` に限定しているため失敗を捕捉しません。①フック内で `p = Promise.reject(new Error('failed'))` を作る、②`f.then = p.then.bind(p)` を持つ関数 f を返す、③操作は拒否されるが次の tick で未捕捉 rejection が発生する、という順序を再現しました。リスナーのない Node の既定設定ではサーバープロセスが終了します。[Promise／thenable の失敗捕捉契約](C:/repo/spreadjs/doc/archived/DD/DD-056/contract.md#L115)どおり、関数型も thenable 判定の対象にして rejection を捕捉してください。

- [P2] thenable 判定中の getter 例外も拒否へ変換する — C:\repo\spreadjs\packages\server-hono\src\server.ts:835-835
  フックが `get then() { throw new Error('failed'); }` を持つ値を返すと、`isPromiseLike` 内の `value.then` 参照が throw します。この判定は下の try/catch の外なので、`permission-denied` にならず RoomBridge の失敗経路へ抜けます。実 WS で接続が切れ、pending が残ったまま拒否通知が届かないことを確認しました。[接続を維持する契約](C:/repo/spreadjs/doc/archived/DD/DD-056/contract.md#L109)に合わせ、`then` の存在確認・取得も例外隔離の内側で行い、不正な getter／Proxy の例外を認可拒否と診断へ変換してください。
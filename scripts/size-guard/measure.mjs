// サイズのガード（DD-065）— 計測。ファイルの行数と、関数ごとの循環的複雑度を測る（純関数・I/O なし）。
//
// 循環的複雑度の数え方（ESLint の complexity に近い）:
//   1 から始め、if・三項演算子・for・for-in・for-of・while・do・case（default を除く）・catch・
//   `&&`・`||`・`??`・`&&=`・`||=`・`??=` を 1 つずつ足す。入れ子の関数は外側に数えず、別の関数として測る。
//
// 関数のキー: 外側の関数の名前を「>」でつないだ道筋（例: createGridController>attachBackendRendering>interceptKeydown）。
//   行番号を使わないので、行がずれても同じ関数と分かる。名前の無い関数は置かれ方から名前を付ける
//   （変数・プロパティ・代入先の名前。呼び出しの引数なら「呼び出す関数名:最初の文字列引数」。
//   例: scroller.addEventListener('pointerdown', …) → addEventListener:pointerdown）。
//   同じ道筋が重なったら、出現順に #2・#3 を付ける。
import ts from 'typescript';

/** 閾値（AGENTS.md「サイズのガード」・DD-065 論点6）。変えるときは DD で決める。 */
export const THRESHOLDS = Object.freeze({ fileLines: 1000, complexity: 30 });

/** 行数（`wc -l` と同じく、末尾の改行の後ろは 1 行に数えない）。 */
export function countLines(text) {
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);

/** 関数 1 つ（入れ子の関数を除く）の循環的複雑度。 */
function complexityOf(fn) {
  let count = 1;
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return; // 入れ子の関数は別に測る
    if (BRANCH_KINDS.has(node.kind)) count++;
    else if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) count++;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return count;
}

function propertyNameText(name, sf) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr)) return calleeName(expr.expression);
  return 'call';
}

function isTransparentWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(node))
  );
}

/** 関数の名前。名前の無い関数は、置かれ方から付ける。 */
function nameOfFunction(node, sf) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) {
    return propertyNameText(node.name, sf);
  }
  if (ts.isGetAccessorDeclaration(node)) return `get ${propertyNameText(node.name, sf)}`;
  if (ts.isSetAccessorDeclaration(node)) return `set ${propertyNameText(node.name, sf)}`;
  if (ts.isConstructorDeclaration(node)) return 'constructor';

  let child = node;
  let parent = node.parent;
  while (parent && isTransparentWrapper(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return '(anonymous)';
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name, sf);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === child) {
    if (ts.isIdentifier(parent.left)) return parent.left.text;
    if (ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text;
    return '(assigned)';
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(child)) {
    const base = ts.isNewExpression(parent) ? `new ${calleeName(parent.expression)}` : calleeName(parent.expression);
    const firstString = parent.arguments.find((arg) => ts.isStringLiteralLike(arg));
    return firstString ? `${base}:${firstString.text}` : `${base}(callback)`;
  }
  if (ts.isReturnStatement(parent)) return '(return)';
  if (ts.isExportAssignment(parent)) return 'default';
  return '(anonymous)';
}

/**
 * 1 ファイルを測る。
 * @param {string} relPath リポジトリ相対の posix パス（キーと結果に使う）
 * @param {string} text ファイルの内容
 * @returns {{ path: string, lines: number, functions: { key: string, complexity: number, line: number }[] }}
 */
export function measureSource(relPath, text) {
  const kind = relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  const functions = [];
  const seen = new Map();
  const visit = (node, trail) => {
    if (ts.isFunctionLike(node) && node.body) {
      const name = nameOfFunction(node, sf);
      const base = [...trail, name].join('>');
      const ordinal = (seen.get(base) ?? 0) + 1;
      seen.set(base, ordinal);
      const segment = ordinal === 1 ? name : `${name}#${ordinal}`;
      const key = [...trail, segment].join('>');
      functions.push({
        key,
        complexity: complexityOf(node),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
      ts.forEachChild(node, (c) => visit(c, [...trail, segment]));
      return;
    }
    ts.forEachChild(node, (c) => visit(c, trail));
  };
  visit(sf, []);
  return { path: relPath, lines: countLines(text), functions };
}

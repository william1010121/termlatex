# Native terminal Markdown + LaTeX

中文文字保持原生。行內公式 $x^2+y^2=r^2$ 和文字一起換行。

高一點的分數 $\frac{a+b}{\sqrt{c}}$ 會保留需要的行高，後面的文字不會被蓋住。

$$
\iint_{-\int\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

## 原生格式

- **粗體**、*斜體*、~~刪除線~~和 [連結](https://example.com)
- 程式碼裡的 `$x$` 保留原文
- 同一個公式再次出現：$x^2+y^2=r^2$

> 引用和公式 $\sum_{i=1}^{n} i$ 可以混合。

| 項目 | 公式 |
| --- | --- |
| 面積 | $\pi r^2$ |
| 分數 | $\frac{1}{2}$ |

```js
const latex = '$not_math$';
```

s 切換公式原文；+/- 只調公式；一般文字大小使用終端自己的縮放。

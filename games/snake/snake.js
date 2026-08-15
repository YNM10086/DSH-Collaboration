// 贪吃蛇 — 蛇（移动逻辑 + 绘制）
// 说明：窗口B 想改"小蛇外形"就主要动这个文件的 draw() 与 Snake 相关实现。

(function () {
  'use strict'

  // 网格尺寸：20x20 格，每格 20px
  const GRID = 20
  const CELL = 20

  class Snake {
    constructor() {
      // 初始蛇身：3 节，向右走
      this.body = [
        { x: 7, y: 10 },
        { x: 6, y: 10 },
        { x: 5, y: 10 },
      ]
      this.dir = { x: 1, y: 0 }     // 当前方向
      this.nextDir = { x: 1, y: 0 } // 缓冲的下一个方向（本 tick 生效）
      this.growing = 0              // 待增长节数
    }

    // 设置方向（禁止 180 度掉头）
    setDirection(x, y) {
      if (x === -this.dir.x && y === -this.dir.y) return
      if (x === this.dir.x && y === this.dir.y) return
      this.nextDir = { x, y }
    }

    // 前进一格；返回是否撞墙/撞自己（游戏结束）
    step() {
      this.dir = this.nextDir
      const head = this.body[0]
      const nx = head.x + this.dir.x
      const ny = head.y + this.dir.y

      // 撞墙
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) return false

      // 撞自己（尾节即将移走，不算）
      const tail = this.body[this.body.length - 1]
      for (let i = 0; i < this.body.length - 1; i++) {
        const s = this.body[i]
        if (s.x === nx && s.y === ny) return false
      }
      void tail

      this.body.unshift({ x: nx, y: ny })
      if (this.growing > 0) {
        this.growing--
      } else {
        this.body.pop()
      }
      return true
    }

    // 吃到食物：增长一格
    grow() {
      this.growing++
    }

    // 蛇头位置
    head() {
      return this.body[0]
    }

    // 是否占据某个格子（食物生成时避开蛇身）
    occupies(x, y) {
      return this.body.some((s) => s.x === x && s.y === y)
    }

    // 绘制（窗口B 外形改造：圆角蛇身 + 头亮尾暗渐变 + 方向性眼睛）
    draw(ctx) {
      const len = this.body.length
      for (let i = len - 1; i >= 0; i--) {
        const s = this.body[i]
        const isHead = i === 0
        // 渐变：头部 #7CFC00 → 尾部 #006400
        const t = len > 1 ? i / (len - 1) : 0
        const r = Math.round(252 + (0 - 252) * t)
        const g = Math.round(124 + (0 - 124) * t)
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',0)'
        const pad = isHead ? 0 : 2
        const x = s.x * CELL + pad
        const y = s.y * CELL + pad
        const size = CELL - pad * 2
        const rad = isHead ? 7 : 5
        // 圆角矩形
        ctx.beginPath()
        ctx.moveTo(x + rad, y)
        ctx.arcTo(x + size, y, x + size, y + size, rad)
        ctx.arcTo(x + size, y + size, x, y + size, rad)
        ctx.arcTo(x, y + size, x, y, rad)
        ctx.arcTo(x, y, x + size, y, rad)
        ctx.closePath()
        ctx.fill()
        // 眼睛（只有头有）：眼白 + 瞳孔，随移动方向看
        if (isHead) {
          const cx = s.x * CELL + CELL / 2
          const cy = s.y * CELL + CELL / 2
          const d = this.dir
          const perpX = -d.y
          const perpY = d.x
          ctx.fillStyle = '#fff'
          for (const side of [-1, 1]) {
            const ex = cx + d.x * 4.5 + perpX * 4 * side
            const ey = cy + d.y * 4.5 + perpY * 4 * side
            ctx.beginPath()
            ctx.arc(ex, ey, 3, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.fillStyle = '#000'
          for (const side of [-1, 1]) {
            const ex = cx + d.x * 4.5 + perpX * 4 * side
            const ey = cy + d.y * 4.5 + perpY * 4 * side
            ctx.beginPath()
            ctx.arc(ex + d.x * 1.2, ey + d.y * 1.2, 1.5, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    }
  }

  window.Snake = Snake
})()

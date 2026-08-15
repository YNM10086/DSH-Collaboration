// 贪吃蛇 — 游戏循环（食物/碰撞/速度/计分）
// 说明：窗口A 想加"难度设置"就主要动这个文件的 SPEED、reset()、loop 相关实现。

(function () {
  'use strict'

  const GRID = 20
  const CELL = 20

  // 基础速度：每 140ms 走一格
  const SPEED_MS = 140

  class Game {
    constructor(canvas) {
      this.canvas = canvas
      this.ctx = canvas.getContext('2d')
      this.snake = new window.Snake()
      this.food = null
      this.score = 0
      this.running = false
      this.paused = false
      this.timer = null
      this.scoreEl = document.getElementById('score')
      this._onKey = this._onKey.bind(this)
    }

    start() {
      this._spawnFood()
      this.running = true
      window.addEventListener('keydown', this._onKey)
      this._tick()
    }

    // 生成食物（避开蛇身）
    _spawnFood() {
      for (;;) {
        const f = {
          x: Math.floor(Math.random() * GRID),
          y: Math.floor(Math.random() * GRID),
        }
        if (!this.snake.occupies(f.x, f.y)) {
          this.food = f
          return
        }
      }
    }

    _tick() {
      if (!this.running) return
      if (this.paused) {
        this.timer = setTimeout(() => this._tick(), SPEED_MS)
        return
      }
      const alive = this.snake.step()
      if (!alive) {
        this._gameOver()
        return
      }
      // 吃到食物
      const head = this.snake.head()
      if (this.food && head.x === this.food.x && head.y === this.food.y) {
        this.snake.grow()
        this.score++
        this.scoreEl.textContent = '得分：' + this.score
        this._spawnFood()
      }
      this._draw()
      this.timer = setTimeout(() => this._tick(), SPEED_MS)
    }

    _draw() {
      const ctx = this.ctx
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      // 网格线
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      for (let i = 1; i < GRID; i++) {
        ctx.beginPath()
        ctx.moveTo(i * CELL, 0)
        ctx.lineTo(i * CELL, this.canvas.height)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(0, i * CELL)
        ctx.lineTo(this.canvas.width, i * CELL)
        ctx.stroke()
      }
      // 食物：红色圆点
      if (this.food) {
        ctx.fillStyle = '#e94560'
        ctx.beginPath()
        ctx.arc(
          this.food.x * CELL + CELL / 2,
          this.food.y * CELL + CELL / 2,
          CELL / 2 - 3,
          0,
          Math.PI * 2
        )
        ctx.fill()
      }
      // 蛇
      this.snake.draw(ctx)
    }

    _gameOver() {
      this.running = false
      clearTimeout(this.timer)
      this.scoreEl.textContent = '游戏结束！得分：' + this.score + '（按任意键重新开始）'
      const restart = () => {
        window.removeEventListener('keydown', restart)
        this.snake = new window.Snake()
        this.score = 0
        this.paused = false
        this.scoreEl.textContent = '得分：0'
        this.start()
      }
      window.addEventListener('keydown', restart)
    }

    _onKey(e) {
      const k = e.key
      const dirs = {
        ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
        ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
        ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
        ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
      }
      if (dirs[k]) {
        e.preventDefault()
        this.snake.setDirection(dirs[k][0], dirs[k][1])
      } else if (k === ' ') {
        e.preventDefault()
        this.paused = !this.paused
        this.scoreEl.textContent = this.paused ? '已暂停（得分：' + this.score + '）' : '得分：' + this.score
      }
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('board')
    const game = new Game(canvas)
    window.snakeGame = game
    game.start()
  })
})()

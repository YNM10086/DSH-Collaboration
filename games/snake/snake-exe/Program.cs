// 贪吃蛇（Windows 可执行版）— WinForms + GDI+
// 协作测试文件划分：
//   - 难度设置（窗口A 的活）：EASY/NORMAL/HARD_MS 档位、难度下拉框、OnDifficultyChanged
//   - 蛇的外形（窗口B 的活）：OnPaintBoard 里的蛇绘制部分（颜色/形状/眼睛）
// 编译：csc.exe /target:winexe /out:Snake.exe Program.cs
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace SnakeGame
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    class MainForm : Form
    {
        const int GRID = 20;        // 20x20 网格
        const int CELL = 20;        // 每格 20px
        // 难度档位（毫秒/格）——窗口A 难度设置
        const int EASY_MS = 200;
        const int NORMAL_MS = 140;
        const int HARD_MS = 90;

        Panel board;
        Label scoreLabel;
        ComboBox difficultyBox;
        Timer timer;
        List<Point> snake = new List<Point>();
        Point dir = new Point(1, 0);
        Point nextDir = new Point(1, 0);
        Point food;
        Random rnd = new Random();
        int score = 0;
        bool paused = false;
        bool over = false;

        public MainForm()
        {
            Text = "贪吃蛇";
            ClientSize = new Size(GRID * CELL, GRID * CELL + 74);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            scoreLabel = new Label();
            scoreLabel.Text = "得分：0";
            scoreLabel.Font = new Font("Microsoft YaHei", 11f, FontStyle.Bold);
            scoreLabel.ForeColor = Color.White;
            scoreLabel.BackColor = Color.FromArgb(26, 26, 46);
            scoreLabel.Dock = DockStyle.Top;
            scoreLabel.Height = 28;
            scoreLabel.TextAlign = ContentAlignment.MiddleCenter;
            Controls.Add(scoreLabel);

            // 难度设置行（窗口A 功能）
            Panel diffRow = new Panel();
            diffRow.Height = 30;
            diffRow.Dock = DockStyle.Top;
            diffRow.BackColor = Color.FromArgb(26, 26, 46);

            Label diffLabel = new Label();
            diffLabel.Text = "难度：";
            diffLabel.Font = new Font("Microsoft YaHei", 10f);
            diffLabel.ForeColor = Color.White;
            diffLabel.AutoSize = true;
            diffLabel.Location = new Point(10, 5);
            diffRow.Controls.Add(diffLabel);

            difficultyBox = new ComboBox();
            difficultyBox.DropDownStyle = ComboBoxStyle.DropDownList;
            difficultyBox.Font = new Font("Microsoft YaHei", 10f);
            difficultyBox.Items.Add("简单（慢）");
            difficultyBox.Items.Add("普通");
            difficultyBox.Items.Add("困难（快）");
            difficultyBox.SelectedIndex = 1;
            difficultyBox.Location = new Point(70, 3);
            difficultyBox.Width = 120;
            difficultyBox.SelectedIndexChanged += OnDifficultyChanged;
            diffRow.Controls.Add(difficultyBox);
            Controls.Add(diffRow);

            board = new DoubleBufferedPanel();
            board.BackColor = Color.FromArgb(22, 33, 62);
            board.Dock = DockStyle.Fill;
            board.Paint += OnPaintBoard;
            Controls.Add(board);

            timer = new Timer();
            timer.Interval = NORMAL_MS;  // 默认普通难度
            timer.Tick += OnTick;
            KeyPreview = true;
            KeyDown += OnKeyDown;

            Reset();
            timer.Start();
        }

        void Reset()
        {
            snake.Clear();
            snake.Add(new Point(7, 10));
            snake.Add(new Point(6, 10));
            snake.Add(new Point(5, 10));
            dir = new Point(1, 0);
            nextDir = new Point(1, 0);
            score = 0;
            paused = false;
            over = false;
            scoreLabel.Text = "得分：0";
            SpawnFood();
        }

        void SpawnFood()
        {
            for (; ; )
            {
                Point f = new Point(rnd.Next(GRID), rnd.Next(GRID));
                if (!snake.Contains(f)) { food = f; return; }
            }
        }

        void OnTick(object sender, EventArgs e)
        {
            if (paused || over) return;
            dir = nextDir;
            Point head = snake[0];
            Point nh = new Point(head.X + dir.X, head.Y + dir.Y);
            // 撞墙
            if (nh.X < 0 || nh.Y < 0 || nh.X >= GRID || nh.Y >= GRID) { GameOver(); return; }
            // 撞自己
            for (int i = 0; i < snake.Count - 1; i++)
                if (snake[i] == nh) { GameOver(); return; }
            snake.Insert(0, nh);
            if (nh == food)
            {
                score++;
                scoreLabel.Text = "得分：" + score;
                SpawnFood();
            }
            else
            {
                snake.RemoveAt(snake.Count - 1);
            }
            board.Invalidate();
        }

        void GameOver()
        {
            over = true;
            timer.Stop();
            scoreLabel.Text = "游戏结束！得分：" + score + "（按回车重新开始）";
        }

        void OnKeyDown(object sender, KeyEventArgs e)
        {
            switch (e.KeyCode)
            {
                case Keys.Up:
                case Keys.W:
                    SetDir(0, -1); e.Handled = true; break;
                case Keys.Down:
                case Keys.S:
                    SetDir(0, 1); e.Handled = true; break;
                case Keys.Left:
                case Keys.A:
                    SetDir(-1, 0); e.Handled = true; break;
                case Keys.Right:
                case Keys.D:
                    SetDir(1, 0); e.Handled = true; break;
                case Keys.Space:
                    if (!over)
                    {
                        paused = !paused;
                        scoreLabel.Text = paused ? "已暂停（得分：" + score + "）" : "得分：" + score;
                    }
                    e.Handled = true;
                    break;
                case Keys.Enter:
                    if (over) { Reset(); timer.Start(); }
                    e.Handled = true;
                    break;
            }
        }

        void SetDir(int x, int y)
        {
            if (x == -dir.X && y == -dir.Y) return;
            if (x == dir.X && y == dir.Y) return;
            nextDir = new Point(x, y);
        }

        // 难度切换：立即生效（窗口A 功能）
        void OnDifficultyChanged(object sender, EventArgs e)
        {
            if (timer == null) return;
            switch (difficultyBox.SelectedIndex)
            {
                case 0: timer.Interval = EASY_MS; break;
                case 1: timer.Interval = NORMAL_MS; break;
                default: timer.Interval = HARD_MS; break;
            }
        }

        void OnPaintBoard(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            // 网格
            using (Pen p = new Pen(Color.FromArgb(255, 255, 255, 12)))
            {
                for (int i = 1; i < GRID; i++)
                {
                    g.DrawLine(p, i * CELL, 0, i * CELL, GRID * CELL);
                    g.DrawLine(p, 0, i * CELL, GRID * CELL, i * CELL);
                }
            }
            // 食物
            using (Brush b = new SolidBrush(Color.FromArgb(233, 69, 96)))
            {
                g.FillEllipse(b, food.X * CELL + 3, food.Y * CELL + 3, CELL - 6, CELL - 6);
            }
            // 蛇 —— 窗口B 外形改造区（圆角蛇身 + 头亮尾暗渐变 + 方向性眼睛）
            for (int i = snake.Count - 1; i >= 0; i--)
            {
                Point s = snake[i];
                bool isHead = i == 0;
                int pad = isHead ? 0 : 2;
                // 渐变：头 #7CFC00 → 尾 #006400
                float t = snake.Count > 1 ? (float)i / (snake.Count - 1) : 0f;
                int r = (int)(252 + (0 - 252) * t);
                int gc = (int)(124 + (0 - 124) * t);
                float x = s.X * CELL + pad, y = s.Y * CELL + pad;
                float size = CELL - pad * 2;
                float rad = isHead ? 7 : 5;
                using (System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath())
                {
                    path.AddArc(x, y, rad * 2, rad * 2, 180, 90);
                    path.AddArc(x + size - rad * 2, y, rad * 2, rad * 2, 270, 90);
                    path.AddArc(x + size - rad * 2, y + size - rad * 2, rad * 2, rad * 2, 0, 90);
                    path.AddArc(x, y + size - rad * 2, rad * 2, rad * 2, 90, 90);
                    path.CloseFigure();
                    using (Brush b = new SolidBrush(Color.FromArgb(r, gc, 0)))
                    {
                        g.FillPath(b, path);
                    }
                }
                if (isHead)
                {
                    // 方向性眼睛：眼白 + 瞳孔，随移动方向看
                    float cx = s.X * CELL + CELL / 2f, cy = s.Y * CELL + CELL / 2f;
                    float dx = dir.X, dy = dir.Y;
                    float px = -dy, py = dx; // 垂直方向
                    using (Brush white = new SolidBrush(Color.White), black = new SolidBrush(Color.Black))
                    {
                        for (int side = -1; side <= 1; side += 2)
                        {
                            float ex = cx + dx * 4.5f + px * 4f * side;
                            float ey = cy + dy * 4.5f + py * 4f * side;
                            g.FillEllipse(white, ex - 3, ey - 3, 6, 6);
                            g.FillEllipse(black, ex + dx * 1.2f - 1.5f, ey + dy * 1.2f - 1.5f, 3, 3);
                        }
                    }
                }
            }
        }
    }

    class DoubleBufferedPanel : Panel
    {
        public DoubleBufferedPanel()
        {
            DoubleBuffered = true;
        }
    }
}

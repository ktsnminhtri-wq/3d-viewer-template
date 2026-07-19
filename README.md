# Trình xem mô hình 3D

Website tĩnh toàn màn hình để xem file `model.glb` bằng Google `<model-viewer>`. Trang hỗ trợ xoay, zoom, cảm ứng, đặt lại góc nhìn, tự động xoay và toàn màn hình.

## Cấu trúc thư mục

```text
.
├── index.html
├── styles.css
├── app.js
├── assets/
│   └── spruit-sunrise-1k-hdr.jpg
├── model.glb
├── model-original.glb
├── package.json
├── package-lock.json
├── scripts/
└── README.md
```

Không đổi tên hoặc di chuyển `model.glb`: trang đang tải model bằng đường dẫn tương đối `./model.glb`.

## Chạy thử trên máy

Không mở trực tiếp `index.html` bằng đường dẫn `file://`, vì trình duyệt có thể chặn việc tải model. Hãy chạy một static server trong thư mục dự án rồi mở địa chỉ được in ra.

### Dùng Python

```bash
python -m http.server 8000
```

Mở [http://localhost:8000](http://localhost:8000).

Nếu máy dùng lệnh `py` thay cho `python`:

```bash
py -m http.server 8000
```

Để dừng server, nhấn `Ctrl+C` trong cửa sổ terminal.

## Cập nhật model và deploy tự động

Thay `model.glb` bằng file GLB mới xuất, sau đó chỉ cần chạy:

```bash
npm run deploy
```

Quy trình sẽ tự động:

1. Tạo bản sao lưu cục bộ `model-source-backup.glb`.
2. Phân tích dung lượng, metadata, material, primitive, texture và dữ liệu không dùng.
3. Tự quyết định có cần tối ưu dựa trên ngưỡng 50/100 MiB và mức lãng phí thực tế.
4. Giữ nguyên hình học và số tam giác hiển thị, gộp material/primitive tương thích, dọn dữ liệu thừa, chuyển texture phù hợp sang WebP và giới hạn texture ở 2048 px.
5. Kiểm tra chuẩn glTF, transparency, số tam giác và đường dẫn `index.html` → `./model.glb` bằng static server cục bộ.
6. Chặn commit nếu bất kỳ file nào vượt 100 MiB hoặc validation thất bại.
7. Commit và push lên branch `main`, rồi in đường dẫn GitHub Pages.

Không cần Blender, Git LFS hoặc lệnh Git thủ công. File sao lưu nguồn chỉ nằm trên máy và được loại khỏi Git bằng `.gitignore`.

## Đưa project lên GitHub

### 1. Tạo repository

1. Đăng nhập GitHub và chọn **New repository**.
2. Nhập tên repository, ví dụ `3d-model-viewer`.
3. Chọn **Public** (GitHub Pages trên tài khoản miễn phí cần repository công khai).
4. Không chọn tạo sẵn README, `.gitignore` hoặc license vì project đã có file.
5. Chọn **Create repository**.

### 2. Khởi tạo Git và push lên branch `main`

Trong terminal, tại thư mục project, chạy các lệnh sau. Thay `YOUR_USERNAME` và `3d-model-viewer` bằng thông tin repository của bạn.

```bash
git init
git add .gitignore index.html styles.css app.js README.md model.glb package.json package-lock.json scripts
git commit -m "Create static 3D model viewer"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/3d-model-viewer.git
git push -u origin main
```

> **Lưu ý về kích thước model:** File `model.glb` đã được tối ưu còn khoảng 25,2 MiB và có thể push bằng Git thông thường. File sao lưu `model-original.glb` khoảng 163,2 MiB được giữ trên máy và đã có trong `.gitignore`; không cố đưa file sao lưu này lên GitHub.

### 3. Bật GitHub Pages

1. Mở repository trên GitHub.
2. Vào **Settings** → **Pages**.
3. Trong **Build and deployment**, chọn **Deploy from a branch**.
4. Chọn branch **main** và thư mục **/ (root)**.
5. Chọn **Save** và đợi GitHub hoàn tất deploy.

### 4. Đường dẫn sau khi deploy

Với repository tên `3d-model-viewer`, website thường có địa chỉ:

```text
https://YOUR_USERNAME.github.io/3d-model-viewer/
```

Nếu repository có tên chính xác là `YOUR_USERNAME.github.io`, địa chỉ sẽ là:

```text
https://YOUR_USERNAME.github.io/
```

## Model gốc và quy trình tối ưu

`model-original.glb` là bản sao lưu nguyên trạng. `model.glb` là bản đã tối ưu dùng cho website. Không đổi tên hai file này.

Các gói Node.js chỉ phục vụ việc tái tạo và kiểm tra bản tối ưu; website vẫn hoàn toàn tĩnh và không có build step. Sau khi chạy `npm install`, có thể dùng:

```bash
npm run optimize:model
npm run validate:model
npm run deploy
```

Lệnh tối ưu luôn đọc `model-original.glb` và ghi bản thử nghiệm thành `model-optimized.glb`; nó không tự ghi đè `model.glb`.

## Ghi chú

- `index.html`, `styles.css`, `app.js` và `model.glb` đều được tham chiếu bằng đường dẫn tương đối, phù hợp với GitHub Pages dạng project site.
- Thư viện Google `<model-viewer>` được tải từ CDN, nên người xem cần có kết nối Internet khi mở trang.
- Vật liệu và texture WebP nhúng trong GLB được hiển thị trực tiếp; website không ghi đè vật liệu của model.
- Model dung lượng lớn có thể cần thêm thời gian tải trên mạng di động. Trang hiển thị phần trăm tải trong thời gian chờ.

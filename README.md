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
├── model-new.glb          # file SketchUp mới, chỉ tồn tại trước preview
├── model.glb
├── model-source-backup.glb # bản sao cục bộ, không đưa lên Git
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

## Quy trình preview và deploy an toàn

Quy trình khuyến nghị:

```text
SketchUp
↓
Xuất model-new.glb
↓
npm run preview
↓
Điều chỉnh Preview Lighting Studio
↓
Save Lighting
↓
Kiểm tra trực quan / chỉnh UI nếu cần
↓
APPROVED
↓
npm run deploy
```

### Preview trên máy

```bash
npm run preview
```

Nếu có `model-new.glb`, lệnh này tự phát hiện file, sao lưu thành `model-source-backup.glb`, tối ưu và tạo `model.glb` cho website. `model-new.glb` không bị thay đổi trong lúc xử lý và chỉ bị xóa sau khi tối ưu cùng toàn bộ validation thành công. Nếu xử lý thất bại, file nguồn vẫn còn nguyên để có thể sửa lỗi hoặc chạy lại.

Sau đó preview mở static server tại [http://localhost:8000](http://localhost:8000). Server tiếp tục chạy cho đến khi nhấn `Ctrl+C`. Khi `model-new.glb`, `model.glb`, `index.html`, `styles.css`, `app.js` hoặc file trong `assets/` thay đổi, preview tự kiểm tra lại và yêu cầu trình duyệt refresh. Nếu không có `model-new.glb`, preview kiểm tra `model.glb` hiện tại như bình thường.

Preview không commit, không push và không thay đổi repository GitHub. Sau mỗi lần kiểm tra thành công, workflow lưu một biên nhận cục bộ trong `.preview-validation.json`; file này được loại khỏi Git.

Trong preview, góc trên bên phải có **Preview Lighting Studio** với các điều khiển exposure, độ đậm/mềm của bóng, góc xoay môi trường và preset Neutral/Studio/Soft/Outdoor/Warm. Các thay đổi hiển thị ngay lập tức. Nút **Save Lighting** ghi lựa chọn vào `lighting-config.json` và cập nhật các giá trị lighting mặc định của viewer.

Panel này chỉ được server preview chèn tạm thời vào trang trả về; nó không nằm trong `index.html` và không xuất hiện trên GitHub Pages. `npm run deploy` đọc `lighting-config.json`, xác nhận các giá trị đã được bake vào `<model-viewer>`, rồi mới thực hiện validation và deploy.

### Deploy an toàn

Sau khi đã xem preview và chấp thuận kết quả, chạy:

```bash
npm run deploy
```

`deploy` chỉ tiếp tục nếu biên nhận preview khớp chính xác với model, viewer và assets hiện tại. Nếu bất kỳ file trực quan nào đổi sau preview, validation thất bại hoặc `model.glb` vượt 100 MiB, lệnh dừng trước commit/push và yêu cầu chạy preview lại.

Với mọi yêu cầu chỉnh ánh sáng, mặc định chỉ preview: không commit, push hoặc deploy. Chỉ khi người dùng nói rõ `APPROVED` mới được phép commit và deploy các thay đổi ánh sáng.

Quy trình sẽ tự động:

1. Ưu tiên phát hiện file SketchUp mới tên `model-new.glb`.
2. Sao lưu chính xác file nguồn thành `model-source-backup.glb` trước khi xử lý.
3. Tối ưu nguồn mới và tạo `model.glb`; chỉ xóa `model-new.glb` sau khi thành công.
4. Phân tích dung lượng, metadata, material, primitive, texture và dữ liệu không dùng.
5. Giữ nguyên hình học và số tam giác hiển thị, gộp material/primitive tương thích, dọn dữ liệu thừa, chuyển texture phù hợp sang WebP và giới hạn texture ở 2048 px.
6. Kiểm tra chuẩn glTF, transparency, số tam giác và đường dẫn `index.html` → `./model.glb` bằng static server cục bộ.
7. Xác nhận lại nội dung vẫn trùng với phiên bản preview đã duyệt.
8. Chặn commit nếu bất kỳ file nào vượt 100 MiB hoặc validation thất bại.
9. Commit và push lên branch `main`, rồi in đường dẫn GitHub Pages.

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

> **Lưu ý về kích thước model:** Chỉ `model.glb` đã tối ưu được đưa lên Git. `model-new.glb` và `model-source-backup.glb` là file nguồn/sao lưu cục bộ và đều được loại khỏi Git bằng `.gitignore`.

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

## File nguồn và quy trình tối ưu

Xuất model mới từ SketchUp với tên `model-new.glb`. Workflow không còn dùng `model-original.glb` làm nguồn. `model-source-backup.glb` là bản sao nguyên trạng gần nhất, còn `model.glb` là kết quả đã tối ưu dùng cho website.

Các gói Node.js chỉ phục vụ việc tái tạo và kiểm tra bản tối ưu; website vẫn hoàn toàn tĩnh và không có build step. Sau khi chạy `npm install`, có thể dùng:

```bash
npm run optimize:model
npm run validate:model
npm run preview
npm run deploy
```

Lệnh `npm run optimize:model` đọc `model-source-backup.glb` và ghi bản thử nghiệm thành `model-optimized.glb`; nó không tự ghi đè `model.glb`. Quy trình nhập tự động từ `model-new.glb` được thực hiện bởi `npm run preview`.

## Ghi chú

- `index.html`, `styles.css`, `app.js` và `model.glb` đều được tham chiếu bằng đường dẫn tương đối, phù hợp với GitHub Pages dạng project site.
- Thư viện Google `<model-viewer>` được tải từ CDN, nên người xem cần có kết nối Internet khi mở trang.
- Vật liệu và texture WebP nhúng trong GLB được hiển thị trực tiếp; website không ghi đè vật liệu của model.
- Model dung lượng lớn có thể cần thêm thời gian tải trên mạng di động. Trang hiển thị phần trăm tải trong thời gian chờ.

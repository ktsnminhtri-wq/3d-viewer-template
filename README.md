# Universal Local GLB Publishing Lab

Project gồm một pipeline Node.js chạy hoàn toàn cục bộ và một website tĩnh dùng Google `<model-viewer>`. Pipeline nhận file GLB ở bất kỳ đường dẫn nào, tạo artifact đã tối ưu/kiểm định trong `dist/current`, rồi viewer dùng artifact đó để preview.

Pipeline runtime không dùng AI. Codex chỉ hỗ trợ phát triển mã nguồn; lệnh publish không gọi dịch vụ AI và không cần phân tích thủ công cho từng model.

## Cài đặt

Yêu cầu Node.js 18 trở lên:

```bash
npm install
```

Không cần Blender, React, framework, Git LFS hoặc build frontend.

## Workflow cơ bản

```text
GLB nguồn ở bất kỳ vị trí nào
↓
npm run publish -- "<source.glb>"
↓
preflight
↓
viewer-safe optimization
↓
validation
↓
dist/current
↓
npm run preview
↓
viewer?model=./dist/current/model.glb
```

### 1. Publish

Ví dụ Windows:

```bash
npm run publish -- "D:\Models\villa.glb"
```

Đường dẫn tương đối cũng được hỗ trợ:

```bash
npm run publish -- ".\exports\interior.glb"
```

Source không cần đổi tên hoặc chép vào project. Publisher chỉ đọc source và tạo một bản làm việc trong thư mục tạm riêng. Source không bị ghi đè, đổi tên hay xóa.

Publish thực hiện:

1. Kiểm tra đường dẫn, phần mở rộng và GLB header.
2. Chạy Khronos glTF Validator trên source.
3. Kiểm tra scene, primitive, số liệu không hữu hạn và world bounds.
4. Báo center, size, khoảng cách tới origin, texture và extension.
5. Chạy profile tối ưu `viewer-safe`.
6. Kiểm định candidate trước/sau.
7. Chỉ sau khi mọi kiểm định thành công mới thay `dist/current`.

Nếu publish thất bại, artifact thành công trước đó trong `dist/current` được giữ nguyên.

### 2. Output

```text
dist/
└── current/
    ├── model.glb
    └── metadata.json
```

`metadata.json` chứa SHA-256, kích thước byte, counts, bounds, texture summary, extensions, profile và validation warnings. File không chứa timestamp, processing time, đường dẫn máy, Git metadata hoặc nhãn do AI tạo.

Trong `dist/`, chỉ `dist/current/model.glb` và `dist/current/metadata.json` được phép đưa lên Git để GitHub Pages phục vụ đúng artifact đã kiểm định. Các artifact tạm hoặc output khác trong `dist/` vẫn bị loại khỏi Git. Deploy adapter đồng thời chép model đã kiểm định sang `model.glb` ở project root để giữ fallback tương thích cũ.

### 3. Preview

Sau khi publish thành công:

```bash
npm run preview
```

Preview mở:

```text
http://localhost:8000/?model=./dist/current/model.glb
```

Preview chỉ phục vụ artifact đã publish. Nó không:

- tìm hoặc tối ưu `model-new.glb`;
- ghi đè/xóa GLB nguồn;
- thay `dist/current/model.glb`;
- commit hoặc push Git.

Preview vẫn chèn Lighting Studio cục bộ. Save Lighting chỉ ghi `lighting-config.json` và bake thuộc tính ánh sáng vào production viewer; không chỉnh model, material hoặc texture.

Để không tự mở trình duyệt:

```bash
npm run preview -- --no-open
```

Đổi port bằng biến môi trường `PREVIEW_PORT` nếu cần.

## Viewer model parameter

Viewer hỗ trợ:

```text
?model=<relative-or-http-url>
```

Ví dụ:

```text
http://localhost:8000/?model=./dist/current/model.glb
https://example.com/viewer/?model=https://cdn.example.com/villa.glb
```

Chỉ URL `http:` và `https:` được chấp nhận. GLB ở domain khác phải được server nguồn cho phép CORS. Khi không có tham số `model`, viewer giữ fallback tương thích cũ là `./model.glb`.

Spatial sketch reference dùng URL model đã resolve làm identity thay vì giả định `surface:model.glb`.

## Profile tối ưu viewer-safe

Optimizer hiện làm:

- deduplicate material bằng so sánh sâu, chỉ bỏ qua tên exporter;
- join primitive tương thích trong cùng mesh;
- prune resource không dùng;
- deduplicate accessor, mesh, texture và material;
- resize texture lớn hơn 2048 px, giữ tỷ lệ;
- chuyển JPEG/PNG sang WebP;
- dùng quality 82 cho texture màu sRGB;
- dùng WebP lossless cho data texture;
- giữ nguyên rendered triangle count.

WebP effort dùng thang 0–100 của glTF Transform và được đặt thành 100, tương ứng effort 6 của Sharp/libwebp.

Profile chưa dùng Draco, Meshopt, KTX2, LOD hoặc geometry simplification.

## Validation

Preflight và candidate validation kiểm tra:

- GLB 2.0 header/chunk hợp lệ;
- Khronos glTF Validator không có error;
- có scene và ít nhất một scene-reachable primitive với POSITION;
- accessor không chứa NaN/Infinity;
- bounds hữu hạn;
- rendered triangle count không đổi;
- bounds trước/sau không dịch chuyển vượt tolerance;
- core material factors vẫn tồn tại;
- transparency được giữ khi có unique texture identity đáng tin cậy;
- output texture không vượt giới hạn profile;
- optimizer không thêm required extension ngoài allowlist của profile.

Model có kích thước hoặc vị trí bất thường chỉ tạo warning nếu vẫn có thể publish an toàn.

## Repeatability

Với cùng source, cùng dependency lockfile, cùng môi trường và cùng profile, chạy publish hai lần phải cho cùng:

- SHA-256 của `dist/current/model.glb`;
- nội dung/SHA-256 của `dist/current/metadata.json`.

Native codec có thể cho output khác giữa hệ điều hành hoặc phiên bản Sharp/libwebp khác nhau. `package-lock.json` cần được giữ để cố định dependency cho mỗi môi trường.

## Deploy GitHub Pages

Sau khi publish và review bằng preview:

```bash
npm run deploy
```

Deploy là adapter riêng, không phải publisher. Nó:

1. Xác minh `dist/current` khớp metadata.
2. Yêu cầu preview receipt còn khớp.
3. Chép artifact đã kiểm định sang `./model.glb` theo cơ chế rollback an toàn.
4. Kiểm tra production viewer bằng local static server.
5. Chỉ stage allowlist file của project.
6. Commit `dist/current/model.glb`, `dist/current/metadata.json` cùng các file production cần thiết rồi push `origin/main`.
7. In URL viewer, model và metadata chính xác, kèm cache key lấy từ SHA-256 của output.

Phần này vẫn cố ý phụ thuộc Git, branch `main`, remote `origin`, giới hạn file 100 MiB và cấu trúc URL GitHub Pages. Đây là adapter legacy, không nằm trong publisher core.

Để bật GitHub Pages: vào **Settings → Pages → Deploy from a branch**, chọn branch **main** và thư mục **/ (root)**.

Project site có dạng:

```text
https://YOUR_USERNAME.github.io/REPOSITORY/
```

Với repository hiện tại, URL kiểm thử trên thiết bị khác là:

```text
https://ktsnminhtri-wq.github.io/3d-viewer-template/?model=./dist/current/model.glb&v=<output-sha-short>
```

Tham số `v` được viewer chuyển tiếp vào request tải GLB, giúp tránh cache model cũ. SHA rút gọn được in tự động sau mỗi lần deploy. GitHub Pages có thể cần vài phút sau khi push để cập nhật; nếu vẫn thấy bản cũ, mở URL mới được in ra hoặc refresh mạnh/xóa cache của trình duyệt.

## Kiểm thử một GLB thứ hai

```bash
npm run publish -- "D:\Models\tower.glb"
npm run preview
```

Kiểm tra `dist/current/metadata.json`, mở URL preview được in ra, thử orbit/zoom, material, transparency, 2P/3P và spatial sketch. Source `D:\Models\tower.glb` phải giữ nguyên SHA, tên và vị trí.

## Giới hạn đã biết

- GLB có external resource tương đối nằm trong cùng thư mục source được chép vào workspace và embed lại; URL resource từ xa hoặc đường dẫn thoát khỏi thư mục source bị từ chối.
- Chưa có visual regression bằng screenshot.
- Transparency chỉ được so sánh nghiêm ngặt khi texture có tên duy nhất đáng tin cậy; trường hợp khác được ghi warning.
- Byte-for-byte determinism được bảo đảm trong môi trường đã kiểm thử, không cam kết giữa các phiên bản native codec khác nhau.
- Viewer và sketch vẫn tải model-viewer/Three.js từ CDN, nên preview UI cần Internet.
- GitHub deploy vẫn là adapter một repository; publisher core không có coupling Git/GitHub.

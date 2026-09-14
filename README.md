# THVL Annotate

独立的视频风险标注工具。只需 Git、Python 3.10+ 和浏览器；无需 GPU 或第三方 Python 库。

```bash
git clone https://github.com/evanli526/thvl-annotate.git
cd thvl-annotate
python annotate.py
```

视频占据工作台主体，右侧是紧凑片段编辑和机器参考。切换视频前会自动保存改动，无需填写视频进度。片段填写分:秒边界、标签、模态和一句人工理由；机器理由不会自动填入人工框。

输入 A1、A2 或 EXPERT，程序会自动打开浏览器，也会打印本地地址。无需网页登录密码。Windows 可使用 `python`，macOS/Linux 可使用 `python3`。

视频从固定云端数据集版本按需播放，不下载整套数据集。仓库仅附带约 6.4 MB 的机器建议和转写，包含 450 条任务、11,482 条机器候选；它们不是人工真值。云端不可访问时需要恢复网络，不能将无法播放视为无风险。

人工结果保存在本机 `.annotation-work/desktop-quality_review_20260914/annotations/`，不会自动同步或上传。结束时交回自己的 A1/A2 文件夹；专家将两份结果放入同一工作目录后运行 `python annotate.py --annotator EXPERT`。保持任务版本一致，拷贝前先备份已有结果。

完整步骤和常见错误见[开始标注](annotate/开始标注.md)，类别判据见[标注规范](annotate/instructions.md)。

这是一份独立发布包，不依赖任何主研究仓库文件。视频、模型、密钥、研究报告和已有人工结果未包含在内。

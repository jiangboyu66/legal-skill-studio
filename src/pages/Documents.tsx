import { useRef, useState } from 'react';
import type { MaterialDocument } from '../../shared/types';
import { api } from '../api';
import { DocumentCard } from '../components/inputs';
import { ErrorNotice, fmtTime, Loading, useAuth, useLoad, useToast } from '../components/ui';

const KIND: Record<string, string> = { pdf: 'PDF', docx: 'Word', image: '图片', text: '文本' };

export default function Documents() {
  const { me, can } = useAuth();
  const toast = useToast();
  const list = useLoad(() => api.documents.list(), []);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<MaterialDocument | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(f?: File) {
    if (!f) return;
    setBusy(true);
    setError(undefined);
    try {
      const d = await api.documents.upload(f);
      toast(`已解析「${d.filename}」：${d.pageCount} 页`);
      list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>物料文件</h1>
          <p>
            上传的 PDF、Word（.docx）、图片和文本会在服务器本地解析：PDF 读取文字层（逐页），Word 提取正文，图片用本地 OCR（不发送给第三方）。解析结果带页码，AI 引用原文时可定位到页；支持视觉的模型还会直接查看原图/原 PDF。请只上传虚构、公开或已脱敏的材料。
          </p>
        </div>
        <div className="actions">
          {can('document.upload') && (
            <>
              <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.md" onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} data-testid="documents-file" />
              <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? '正在解析…' : '上传文件'}
              </button>
            </>
          )}
        </div>
      </div>
      <ErrorNotice error={error ?? list.error} />
      {!list.data && !list.error && <Loading />}
      {list.data && (
        <div className="grid-2">
          <div className="list">
            {list.data.length === 0 && <div className="empty">还没有上传的文件。</div>}
            <table className="t" data-testid="documents-table">
              <tbody>
                {list.data.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button className="ghost" onClick={() => api.documents.get(d.id).then(setOpen).catch(setError)}>
                        {d.filename}
                      </button>
                    </td>
                    <td>
                      <span className="badge">{KIND[d.kind]}</span>
                    </td>
                    <td className="small">{d.pageCount} 页</td>
                    <td className="small">{d.warnings.length ? <span className="badge warn">{d.warnings.length} 条提示</span> : ''}</td>
                    <td className="small muted">{fmtTime(d.createdAt)}</td>
                    <td>
                      {(d.uploadedBy === me.user.id || me.user.role === 'admin') && (
                        <button
                          className="ghost sm danger"
                          onClick={async () => {
                            if (!window.confirm(`删除「${d.filename}」？`)) return;
                            try {
                              await api.documents.remove(d.id);
                              list.reload();
                            } catch (e) {
                              setError(e);
                            }
                          }}
                        >
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            {open ? (
              <div className="panel" data-testid="document-viewer">
                <DocumentCard doc={{ ...open, pageCount: open.pages.length, chars: open.pages.reduce((n, p) => n + p.text.length, 0), preview: '' }} />
                {open.pages.map((p) => (
                  <div key={p.n} className="page-text">
                    <div className="out-key">
                      第 {p.n} 页{p.ocrConfidence !== undefined ? `（OCR 置信度 ${p.ocrConfidence}%）` : ''}
                    </div>
                    <pre className="raw">{p.text || '（本页没有提取到文字）'}</pre>
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel muted small">点击左侧文件名查看逐页提取的文字。</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Upload Page — Drag-and-drop PRF upload with real-time progress.
 */
import type { DragEvent, ChangeEvent } from 'react';
import { useState, useRef } from 'react';
import api from '../api/client';

interface UploadedFile {
  id: string;
  name: string;
  status: 'uploading' | 'uploaded' | 'processing' | 'completed' | 'failed';
  progress: number;
  ocrStatus?: string;
}

export default function Upload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [dragover, setDragover] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragover(true);
  };

  const handleDragLeave = () => setDragover(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragover(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    uploadFiles(droppedFiles);
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      uploadFiles(Array.from(e.target.files));
    }
  };

  const uploadFiles = async (fileList: File[]) => {
    for (const file of fileList) {
      const fileId = crypto.randomUUID();

      setFiles(prev => [...prev, {
        id: fileId,
        name: file.name,
        status: 'uploading',
        progress: 0,
      }]);

      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('document_type', 'prf');

        const res = await api.post('/api/documents/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (progressEvent) => {
            const pct = progressEvent.total
              ? Math.round((progressEvent.loaded * 100) / progressEvent.total)
              : 0;
            setFiles(prev =>
              prev.map(f => f.id === fileId ? { ...f, progress: pct } : f)
            );
          },
        });

        setFiles(prev =>
          prev.map(f => f.id === fileId ? {
            ...f,
            id: res.data.id,
            status: 'uploaded',
            progress: 100,
            ocrStatus: res.data.ocr_status,
          } : f)
        );

        pollOCRStatus(res.data.id);

      } catch (err: any) {
        setFiles(prev =>
          prev.map(f => f.id === fileId ? { ...f, status: 'failed', progress: 0 } : f)
        );
      }
    }
  };

  const pollOCRStatus = async (docId: string) => {
    const maxPolls = 60;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const res = await api.get(`/api/documents/${docId}`);
        const ocrStatus = res.data.ocr_status;

        setFiles(prev =>
          prev.map(f => f.id === docId ? {
            ...f,
            status: ocrStatus === 'completed' ? 'completed' : ocrStatus === 'failed' ? 'failed' : 'processing',
            ocrStatus,
          } : f)
        );

        if (ocrStatus === 'completed' || ocrStatus === 'failed') break;
      } catch {
        break;
      }
    }
  };

  const getStatusBadge = (status: string) => {
    const map: Record<string, string> = {
      uploading: 'badge-processing',
      uploaded: 'badge-pending',
      processing: 'badge-processing',
      completed: 'badge-completed',
      failed: 'badge-failed',
    };
    return `badge ${map[status] || 'badge-pending'}`;
  };

  return (
    <div className="page-content">

      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        {/* Upload Zone */}
        <div
          className={`upload-zone ${dragover ? 'dragover' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInput.current?.click()}
          id="upload-dropzone"
        >
          <div className="upload-zone-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="upload-zone-title">
            Drop PRF files here or click to browse
          </div>
          <div className="upload-zone-subtitle">
            Supports PDF, PNG, JPG, TIFF – up to 50MB per file
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif,.bmp,.webp"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
            id="file-input"
          />
        </div>

        {/* Uploaded Files List */}
        {files.length > 0 && (
          <div style={{ marginTop: 32 }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>
              Upload Queue ({files.length} files)
            </h3>
            {files.map((file) => (
              <div key={file.id} className="file-item">
                <div className="file-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
                <div className="file-info">
                  <div className="file-name">{file.name}</div>
                  <div className="file-meta">
                    {file.status === 'uploading' ? `Uploading ${file.progress}%` :
                     file.status === 'processing' ? 'AI extraction in progress...' :
                     file.status === 'completed' ? 'Extraction complete ✓' :
                     file.status === 'failed' ? 'Processing failed' :
                     'Queued for processing'}
                  </div>
                  {file.status === 'uploading' && (
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${file.progress}%` }} />
                    </div>
                  )}
                </div>
                <span className={getStatusBadge(file.status)}>
                  {file.status === 'uploading' && (
                    <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                  )}
                  {file.ocrStatus || file.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

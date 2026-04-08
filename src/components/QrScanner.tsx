import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

interface QrScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
}

const PW = 640;
const PH = 360;

const QrScanner = ({ onScan, onClose }: QrScannerProps) => {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const animRef     = useRef<number | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const doneRef     = useRef(false);
  const onScanRef   = useRef(onScan);
  onScanRef.current = onScan;
  const grayRef     = useRef(new Uint8Array(PW * PH));
  const integralRef = useRef(new Int32Array((PW + 1) * (PH + 1)));

  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    doneRef.current = false;

    const adaptiveThreshold = (imageData: ImageData): void => {
      const { data, width, height } = imageData;
      const gray     = grayRef.current;
      const integral = integralRef.current;
      const S  = 8;
      const T  = 0.85;
      const w1 = width + 1;

      for (let i = 0, j = 0; j < data.length; i++, j += 4) {
        gray[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) | 0;
      }

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          integral[(y + 1) * w1 + (x + 1)] =
            gray[y * width + x]
            + integral[y * w1 + (x + 1)]
            + integral[(y + 1) * w1 + x]
            - integral[y * w1 + x];
        }
      }

      for (let y = 0; y < height; y++) {
        const y1 = Math.max(0, y - S);
        const y2 = Math.min(height - 1, y + S);
        for (let x = 0; x < width; x++) {
          const x1  = Math.max(0, x - S);
          const x2  = Math.min(width - 1, x + S);
          const cnt = (y2 - y1 + 1) * (x2 - x1 + 1);
          const sum =
              integral[(y2 + 1) * w1 + (x2 + 1)]
            - integral[y1 * w1 + (x2 + 1)]
            - integral[(y2 + 1) * w1 + x1]
            + integral[y1 * w1 + x1];
          const val = gray[y * width + x] < (sum / cnt) * T ? 0 : 255;
          const j   = (y * width + x) * 4;
          data[j] = data[j + 1] = data[j + 2] = val;
        }
      }
    };

    const scanFrame = () => {
      const video  = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || doneRef.current) {
        animRef.current = requestAnimationFrame(scanFrame);
        return;
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { animRef.current = requestAnimationFrame(scanFrame); return; }

      canvas.width  = PW;
      canvas.height = PH;
      ctx.drawImage(video, 0, 0, PW, PH);

      const imageData = ctx.getImageData(0, 0, PW, PH);
      adaptiveThreshold(imageData);

      const code = jsQR(imageData.data, PW, PH, {
        inversionAttempts: 'attemptBoth',
      });

      if (code && !doneRef.current) {
        doneRef.current = true;
        cleanup();
        onScanRef.current(code.data);
        return;
      }

      animRef.current = requestAnimationFrame(scanFrame);
    };

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width:  { ideal: 1280 },
            height: { ideal: 720  },
          },
        });

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setIsScanning(true);
          setError(null);
          animRef.current = requestAnimationFrame(scanFrame);
        }
      } catch (err) {
        console.error('Camera error:', err);
        setError('Camera access denied or not available. Please enter the key manually.');
      }
    };

    startCamera();

    return () => {
      cleanup();
    };
  }, []);

  const cleanup = () => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4">
      <div className="bg-card rounded-2xl border-2 border-border p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">Scan QR Code</h3>
          <button
            onClick={() => { cleanup(); onClose(); }}
            className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50/50 p-4 text-center">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        ) : (
          <>
            <div className="relative aspect-square rounded-lg overflow-hidden bg-black">
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
              <canvas ref={canvasRef} className="hidden" />

              {!isScanning && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                </div>
              )}

              {isScanning && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-4 left-4 w-10 h-10 border-l-4 border-t-4 border-primary rounded-tl-lg" />
                  <div className="absolute top-4 right-4 w-10 h-10 border-r-4 border-t-4 border-primary rounded-tr-lg" />
                  <div className="absolute bottom-4 left-4 w-10 h-10 border-l-4 border-b-4 border-primary rounded-bl-lg" />
                  <div className="absolute bottom-4 right-4 w-10 h-10 border-r-4 border-b-4 border-primary rounded-br-lg" />
                </div>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground text-center">
              Point your camera at the QR code containing your WIF private key.
            </p>
          </>
        )}

        <button
          onClick={() => { cleanup(); onClose(); }}
          className="mt-4 w-full rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default QrScanner;

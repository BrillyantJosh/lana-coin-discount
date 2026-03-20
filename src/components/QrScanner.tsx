import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface QrScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
}

const QrScanner = ({ onScan, onClose }: QrScannerProps) => {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const [error, setError] = useState<string | null>(null);
  const [scannedValue, setScannedValue] = useState<string | null>(null);
  const containerId = 'qr-reader';

  useEffect(() => {
    let stopped = false;
    const scanner = new Html5Qrcode(containerId);
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        (decodedText) => {
          if (stopped) return;
          stopped = true;
          // Stop scanner FIRST, then deliver value — prevents DOM conflict on unmount
          scanner.stop()
            .catch(() => {})
            .finally(() => {
              setScannedValue(decodedText);
            });
        },
        () => {} // ignore scan failures (no QR in frame)
      )
      .catch((err) => {
        console.error('QR Scanner error:', err);
        setError('Camera access denied or not available. Please enter the key manually.');
      });

    return () => {
      stopped = true;
      if (scannerRef.current) {
        try {
          scannerRef.current.stop().catch(() => {});
        } catch {
          // scanner may already be stopped
        }
      }
    };
  }, []);

  // Deliver scanned value to parent AFTER scanner is fully stopped
  useEffect(() => {
    if (scannedValue !== null) {
      onScanRef.current(scannedValue);
    }
  }, [scannedValue]);

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4">
      <div className="bg-card rounded-2xl border-2 border-border p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">Scan QR Code</h3>
          <button
            onClick={onClose}
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
            <div id={containerId} className="rounded-lg overflow-hidden" />
            <p className="mt-3 text-xs text-muted-foreground text-center">
              Point your camera at the QR code containing your WIF private key.
            </p>
          </>
        )}

        <button
          onClick={onClose}
          className="mt-4 w-full rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default QrScanner;

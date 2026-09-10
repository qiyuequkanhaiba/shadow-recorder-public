import { useEffect, useState } from 'react';

function resolveDocumentVisible(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  return document.visibilityState !== 'hidden';
}

export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(resolveDocumentVisible);

  useEffect(() => {
    const update = () => {
      setVisible(resolveDocumentVisible());
    };

    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);

    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  return visible;
}

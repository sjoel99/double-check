import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

/**
 * Janela que sobe do pé da tela, sobre um <dialog> nativo: o foco fica preso
 * dentro dela, Esc e o toque fora chamam `onClose`, e ao fechar o foco volta
 * para onde estava. `onClose` é obrigatório: toda janela tem um jeito de sair.
 */
export function Sheet({ label, onClose, children, style }: { label: string; onClose: () => void; children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => {
      if (d.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="sheet-wrap"
      aria-label={label}
      onCancel={(e) => {
        // Esc: fecha pelo nosso caminho (o padrão fecharia o <dialog> e deixaria o componente montado).
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" style={{ alignItems: "stretch", ...style }}>
        <div className="grab" style={{ alignSelf: "center" }} aria-hidden="true" />
        {children}
      </div>
    </dialog>
  );
}

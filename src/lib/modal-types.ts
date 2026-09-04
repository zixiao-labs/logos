export interface ModalActions {
  /** False means save was cancelled or a conflict remains. */
  save?: () => Promise<boolean>;
  close?: () => Promise<boolean>;
  command?: (command: string) => void;
}

export interface ModalUI {
  mode: (mode: string, pending?: string) => void;
  notify: (message: string) => void;
  prompt: (label: string, submit: (value: string) => void, initial?: string) => void;
  command: (value: string) => void;
}

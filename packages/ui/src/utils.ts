import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import "./theme-compat"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

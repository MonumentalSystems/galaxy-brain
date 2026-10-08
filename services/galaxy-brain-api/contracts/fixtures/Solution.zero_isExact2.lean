import Proofs.Defs.D01a0e7277f96727382ac4b7d7d828193
import Proofs.Target.T01a0ea16f0d67abca36cca0bc167d841

section LeanProofsSource


open LeanProofsP2M.Rosetta.CellularMemory.Chain3 LeanProofsP2M LeanProofsP2M.Rosetta LeanProofsP2M.Rosetta.CellularMemory
set_option maxSynthPendingDepth 3
set_option relaxedAutoImplicit false



open LeanProofsP2M

open LeanProofsP2M.Rosetta

open LeanProofsP2M.Rosetta.CellularMemory

open LeanProofsP2M.Rosetta.CellularMemory.Chain3

variable (R : Type*) [CommRing R]

variable (C0 C1 C2 C3 : Type*)

variable [AddCommGroup C0] [AddCommGroup C1] [AddCommGroup C2] [AddCommGroup C3]

variable [Module R C0] [Module R C1] [Module R C2] [Module R C3]

variable {R C0 C1 C2 C3}

namespace LeanProofsP2M.Rosetta.CellularMemory.Chain3

theorem zero_isExact2 (K : Chain3 R C0 C1 C2 C3) : K.IsExact2 0 := by
  refine ⟨0, ?_⟩
  ext face
  rfl

end LeanProofsP2M.Rosetta.CellularMemory.Chain3

end LeanProofsSource

theorem solution : type_of% @Proofs.Target.T01a0ea16f0d67abca36cca0bc167d841.statement :=
  @LeanProofsP2M.Rosetta.CellularMemory.Chain3.zero_isExact2

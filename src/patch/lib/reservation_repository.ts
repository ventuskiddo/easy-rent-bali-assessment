import type { ReservationRepository } from "./types.js";

type ReservationState = "available" | "held" | "confirmed";

interface VehicleEntry {
  state: ReservationState;
  bookingId?: string;
}

/** Atomic in-memory compare-and-set repository for vehicle availability. */
export class InMemoryReservationRepository implements ReservationRepository {
  private readonly vehicles = new Map<string, VehicleEntry>();

  constructor(vehicleIds: readonly string[]) {
    for (const vehicleId of vehicleIds) {
      this.vehicles.set(vehicleId, { state: "available" });
    }
  }

  async reserveIfAvailable(
    vehicleId: string,
    bookingId: string,
  ): Promise<boolean> {
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle || vehicle.state !== "available") {
      return false;
    }
    this.vehicles.set(vehicleId, { state: "held", bookingId });
    return true;
  }

  async confirmReservation(
    vehicleId: string,
    bookingId: string,
  ): Promise<boolean> {
    const vehicle = this.vehicles.get(vehicleId);
    if (
      !vehicle ||
      vehicle.state !== "held" ||
      vehicle.bookingId !== bookingId
    ) {
      return false;
    }
    this.vehicles.set(vehicleId, { state: "confirmed", bookingId });
    return true;
  }

  async releaseReservation(
    vehicleId: string,
    bookingId: string,
  ): Promise<boolean> {
    const vehicle = this.vehicles.get(vehicleId);
    if (
      !vehicle ||
      (vehicle.state !== "held" && vehicle.state !== "confirmed") ||
      vehicle.bookingId !== bookingId
    ) {
      return false;
    }
    this.vehicles.set(vehicleId, { state: "available" });
    return true;
  }

  getState(vehicleId: string): ReservationState | "unknown" {
    return this.vehicles.get(vehicleId)?.state ?? "unknown";
  }
}
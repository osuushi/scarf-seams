export class Point {
  x: number;
  y: number;
  z: number;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  clone() {
    return new Point(this.x, this.y, this.z);
  }

  get length() {
    return 3;
  }

  distanceTo(otherPoint: Point) {
    return (
      ((this.x - otherPoint.x) ** 2 +
        (this.y - otherPoint.y) ** 2 +
        (this.z - otherPoint.z) ** 2) **
      0.5
    );
  }

  subtract(otherPoint: Point): Vec<3> {
    return [
      this.x - otherPoint.x,
      this.y - otherPoint.y,
      this.z - otherPoint.z,
    ];
  }

  addVector(vec: Vec<3>): Point {
    return new Point(this.x + vec[0], this.y + vec[1], this.z + vec[2]);
  }

  toVector(): Vec<3> {
    return [this.x, this.y, this.z];
  }

  isFinite() {
    return isFinite(this.x) && isFinite(this.y) && isFinite(this.z);
  }

  get [Symbol.toStringTag]() {
    return `{${this.x}, ${this.y}, ${this.z}}`;
  }

  // A point with infinite coordinates. By convention, we use Infinity when a
  // coordinate is not known.
  static get unknown(): Point {
    return new Point(Infinity, Infinity, Infinity);
  }

  static get zero(): Point {
    return new Point(0, 0, 0);
  }
}

export type Coordinate = 'x' | 'y' | 'z';

export type Vec<T> = number[] & { length: T };

export function norm<T>(vec: Vec<T>) {
  return vec.reduce((sum, v) => sum + v ** 2, 0) ** 0.5;
}

export function vMul<T>(vec: Vec<T>, scalar: number) {
  return vec.map((v) => v * scalar) as Vec<T>;
}

export function vAdd<T>(vec1: Vec<T>, vec2: Vec<T>) {
  return vec1.map((v, i) => v + vec2[i]) as Vec<T>;
}

export function vLerp<T>(vec1: Vec<T>, vec2: Vec<T>, t: number) {
  return vAdd(vec1, vMul(vSub(vec2, vec1), t));
}

export function vSub<T>(vec1: Vec<T>, vec2: Vec<T>) {
  return vAdd(vec1, vMul(vec2, -1));
}

export function normalize<T>(vec: Vec<T>) {
  return vMul(vec, 1 / norm(vec));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function lerpPoints(a: Point, b: Point, t: number) {
  return new Point(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
}

export type PrintMove = {
  point: Point;
  extrusion: number;
};

export type MoveMode = 'absolute' | 'relative';

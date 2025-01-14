import Matrix from "./Matrix.js";

import Rectangle from "./Rectangle.js";
import effectTransformPoint from "./effectTransformPoint.js";
import { effectBitmasks } from "./effectInfo.js";

import { Sprite, Stage } from "../Sprite.js";

// Returns the determinant of two vectors, the vector from A to B and the vector
// from A to C. If positive, it means AC is counterclockwise from AB.
// If negative, AC is clockwise from AB.
const determinant = (a, b, c) => {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
};

// Used to track whether a sprite's transform has changed since we last looked
// at it.
// TODO: store renderer-specific data on the sprite and have *it* set a
// "transform changed" flag.
class SpriteTransformDiff {
  constructor(sprite) {
    this._sprite = sprite;
    this._unset = true;
    this.update();
  }

  update() {
    this._lastX = this._sprite.x;
    this._lastY = this._sprite.y;
    this._lastRotation = this._sprite.direction;
    this._lastRotationStyle = this._sprite.rotationStyle;
    this._lastSize = this._sprite.size;
    this._lastCostume = this._sprite.costume;
    this._lastCostumeLoaded = this._sprite.costume.img.complete;
    this._unset = false;
  }

  get changed() {
    return (
      this._lastX !== this._sprite.x ||
      this._lastY !== this._sprite.y ||
      this._lastRotation !== this._sprite.direction ||
      this._lastRotationStyle !== this._sprite.rotationStyle ||
      this._lastSize !== this._sprite.size ||
      this._lastCostume !== this._sprite.costume ||
      this._lastCostumeLoaded !== this._sprite.costume.img.complete ||
      this._unset
    );
  }
}

// Renderer-specific data for an instance (the original or a clone) of a Sprite
export default class Drawable {
  constructor(renderer, sprite) {
    this._renderer = renderer;
    this._sprite = sprite;

    // Transformation matrix for the sprite.
    this._matrix = Matrix.create();
    // Track when the sprite's transform changes so we can recalculate the
    // transform matrix.
    this._matrixDiff = new SpriteTransformDiff(sprite);
    this._calculateSpriteMatrix();

    // Track when the image data used to calculate the convex hull,
    // or distortion effects that affect how it's drawn, change.
    // We also need the image data to know how big the pixels are.
    this._convexHullImageData = null;
    this._convexHullMosaic = 0;
    this._convexHullPixelate = 0;
    this._convexHullWhirl = 0;
    this._convexHullFisheye = 0;
    this._convexHullPoints = null;

    this._aabb = new Rectangle();
    this._tightBoundingBox = new Rectangle();
    // Track when the sprite's transform changes so we can recalculate the
    // tight bounding box.
    this._convexHullMatrixDiff = new SpriteTransformDiff(sprite);
  }

  getCurrentSkin() {
    return this._renderer._getSkin(this._sprite.costume);
  }

  // Get the rough axis-aligned bounding box for this sprite. Not as tight as
  // getTightBoundingBox, especially when rotated.
  getAABB() {
    return Rectangle.fromMatrix(this.getMatrix(), this._aabb);
  }

  // Get the Scratch-space tight bounding box for this sprite.
  getTightBoundingBox() {
    if (!this._convexHullMatrixDiff.changed) return this._tightBoundingBox;

    const matrix = this.getMatrix();
    const convexHullPoints = this._calculateConvexHull();
    // Maybe the costume isn't loaded yet. Return a 0x0 bounding box around the
    // center of the sprite.
    if (convexHullPoints === null) {
      return Rectangle.fromBounds(
        this._sprite.x,
        this._sprite.y,
        this._sprite.x,
        this._sprite.y,
        this._tightBoundingBox
      );
    }

    let left = Infinity;
    let right = -Infinity;
    let top = -Infinity;
    let bottom = Infinity;
    const transformedPoint = [0, 0];

    // Each convex hull point is the center of a pixel. However, said pixels
    // each have area. We must take into account the size of the pixels when
    // calculating the bounds. The pixel dimensions depend on the scale and
    // rotation (as we're treating pixels as squares, which change dimensions
    // when rotated).
    const xa = matrix[0] / 2;
    const xb = matrix[3] / 2;
    const halfPixelX =
      (Math.abs(xa) + Math.abs(xb)) / this._convexHullImageData.width;
    const ya = matrix[1] / 2;
    const yb = matrix[4] / 2;
    const halfPixelY =
      (Math.abs(ya) + Math.abs(yb)) / this._convexHullImageData.height;

    // Transform every point in the convex hull using our transform matrix,
    // and expand the bounds to include that point.
    for (let i = 0; i < convexHullPoints.length; i++) {
      const point = convexHullPoints[i];
      transformedPoint[0] = point[0];
      transformedPoint[1] = 1 - point[1];
      Matrix.transformPoint(matrix, transformedPoint, transformedPoint);

      left = Math.min(left, transformedPoint[0] - halfPixelX);
      right = Math.max(right, transformedPoint[0] + halfPixelX);
      top = Math.max(top, transformedPoint[1] + halfPixelY);
      bottom = Math.min(bottom, transformedPoint[1] - halfPixelY);
    }

    Rectangle.fromBounds(left, right, bottom, top, this._tightBoundingBox);
    this._convexHullMatrixDiff.update();
    return this._tightBoundingBox;
  }

  _calculateConvexHull() {
    const sprite = this._sprite;
    const skin = this.getCurrentSkin();
    const imageData = skin.getImageData(
      "size" in sprite ? sprite.size / 100 : 1
    );
    if (!imageData) return null;

    // We only need to recalculate the convex hull points if the image data's
    // changed since we last calculated the convex hull, or if the sprite's
    // effects which distort its shape have changed.
    const { mosaic, pixelate, whirl, fisheye } = sprite.effects;
    if (
      this._convexHullImageData === imageData &&
      this._convexHullMosaic === mosaic &&
      this._convexHullPixelate === pixelate &&
      this._convexHullWhirl === whirl &&
      this._convexHullFisheye === fisheye
    ) {
      return this._convexHullPoints;
    }

    const effectBitmask =
      sprite.effects._bitmask &
      (effectBitmasks.mosaic |
        effectBitmasks.pixelate |
        effectBitmasks.whirl |
        effectBitmasks.fisheye);

    const leftHull = [];
    const rightHull = [];

    const { width, height, data } = imageData;

    const pixelPos = [0, 0];
    const effectPos = [0, 0];
    let currentPoint;
    // Not Scratch-space: y increases as we go downwards
    // Loop over all rows of pixels in the costume, starting at the top
    for (let y = 0; y < height; y++) {
      pixelPos[1] = (y + 0.5) / height;

      // We start at the leftmost point, then go rightwards until we hit an
      // opaque pixel
      let x = 0;
      for (; x < width; x++) {
        pixelPos[0] = (x + 0.5) / width;
        let pixelX = x;
        let pixelY = y;
        if (effectBitmask !== 0) {
          effectTransformPoint(this, pixelPos, effectPos);
          pixelX = Math.floor(effectPos[0] * width);
          pixelY = Math.floor(effectPos[1] * height);
        }
        // We hit an opaque pixel
        if (data[(pixelY * width + pixelX) * 4 + 3] > 0) {
          currentPoint = [pixelPos[0], pixelPos[1]];
          break;
        }
      }

      // There are no opaque pixels on this row. Go to the next one.
      if (x >= width) continue;

      // If appending the current point to the left hull makes a
      // counterclockwise turn, we want to append the current point to it.
      // Otherwise, we remove hull points until the current point makes a
      // counterclockwise turn with the last two points.
      while (leftHull.length >= 2) {
        if (
          determinant(
            leftHull[leftHull.length - 1],
            leftHull[leftHull.length - 2],
            currentPoint
          ) > 0
        ) {
          break;
        }

        leftHull.pop();
      }

      leftHull.push(currentPoint);

      // Now we repeat the process for the right side, looking leftwards for an
      // opaque pixel.
      for (x = width - 1; x >= 0; x--) {
        pixelPos[0] = (x + 0.5) / width;
        effectTransformPoint(this, pixelPos, effectPos);
        let pixelX = x;
        let pixelY = y;
        if (effectBitmask !== 0) {
          effectTransformPoint(this, pixelPos, effectPos);
          pixelX = Math.floor(effectPos[0] * width);
          pixelY = Math.floor(effectPos[1] * height);
        }
        // We hit an opaque pixel
        if (data[(pixelY * width + pixelX) * 4 + 3] > 0) {
          currentPoint = [pixelPos[0], pixelPos[1]];
          break;
        }
      }

      // Because we're coming at this from the right, it goes clockwise.
      while (rightHull.length >= 2) {
        if (
          determinant(
            rightHull[rightHull.length - 1],
            rightHull[rightHull.length - 2],
            currentPoint
          ) < 0
        ) {
          break;
        }

        rightHull.pop();
      }

      rightHull.push(currentPoint);
    }

    // Add points from the right side in reverse order so all the points are
    // clockwise.
    for (let i = rightHull.length - 1; i >= 0; i--) {
      leftHull.push(rightHull[i]);
    }

    this._convexHullPoints = leftHull;
    this._convexHullMosaic = mosaic;
    this._convexHullPixelate = pixelate;
    this._convexHullWhirl = whirl;
    this._convexHullFisheye = fisheye;
    this._convexHullImageData = imageData;

    return this._convexHullPoints;
  }

  _calculateSpriteMatrix() {
    const m = this._matrix;
    Matrix.identity(m);
    const spr = this._sprite;
    if (!(spr instanceof Stage)) {
      Matrix.translate(m, m, spr.x, spr.y);
      switch (spr.rotationStyle) {
        case Sprite.RotationStyle.ALL_AROUND: {
          Matrix.rotate(m, m, spr.scratchToRad(spr.direction));
          break;
        }
        case Sprite.RotationStyle.LEFT_RIGHT: {
          if (spr.direction < 0) Matrix.scale(m, m, -1, 1);
          break;
        }
      }

      const spriteScale = spr.size / 100;
      Matrix.scale(m, m, spriteScale, spriteScale);
    }

    const scalingFactor = 1 / spr.costume.resolution;
    // Rotation centers are in non-Scratch space (positive y-values = down),
    // but these transforms are in Scratch space (negative y-values = down).
    Matrix.translate(
      m,
      m,
      -spr.costume.center.x * scalingFactor,
      (spr.costume.center.y - spr.costume.height) * scalingFactor
    );
    Matrix.scale(
      m,
      m,
      spr.costume.width * scalingFactor,
      spr.costume.height * scalingFactor
    );

    // Store the values we used to compute the matrix so we only recalculate
    // the matrix when we really need to.
    this._matrixDiff.update();
  }

  getMatrix() {
    // If all the values we used to calculate the matrix haven't changed since
    // we last calculated the matrix, we can just return the matrix as-is.
    if (this._matrixDiff.changed) {
      this._calculateSpriteMatrix();
    }

    return this._matrix;
  }
}

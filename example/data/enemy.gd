class_name Enemy
extends Resource

enum Tier { COMMON, ELITE, BOSS }

@export var name: String = ""
@export var hp: int = 10
@export var speed: float = 1.0
@export var tier: Tier = Tier.COMMON
@export_enum("Fire", "Ice", "Poison") var element: String = "Fire"
@export var flying: bool = false
@export var tint: Color = Color(1, 1, 1, 1)
@export var size: Vector2 = Vector2(1, 1)
@export var sprite: Texture2D
